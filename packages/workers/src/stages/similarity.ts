import { type Job, type Worker } from "bullmq";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  PipelineStage,
  type SimilarityJobData,
  type CategorySplitJobData,
} from "@exams2quiz/shared/types";
import { getConfig } from "@exams2quiz/shared/config";
import { createWorker, addJob } from "@exams2quiz/shared/queue";
import { getDb } from "@exams2quiz/shared/db";
import { logStageEvent, trackSimilarityGroups } from "../metrics.js";

// ─── Constants ────────────────────────────────────────────────────
const BI_ENCODER_MODEL = "Xenova/multilingual-e5-small";
const CROSS_ENCODER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const DEFAULT_CROSS_ENCODER_THRESHOLD = 0.7;
const DEFAULT_REFINE_THRESHOLD = 10;
const REFINE_CROSS_ENCODER_THRESHOLD = 0.85;
const MIN_CLUSTER_SIZE = 2;
const EMBEDDING_BATCH_SIZE = 32;

// ─── Types ────────────────────────────────────────────────────────
interface CategorizedQuestionEntry {
  file: string;
  success: boolean;
  source_folder?: string;
  data?: {
    question_number: string;
    points: number;
    question_text: string;
    question_type: string;
    correct_answer: string;
    options?: string[];
  };
  categorization: {
    success: boolean;
    category?: string;
    reasoning?: string;
    error?: string;
  };
  similarity_group_id?: string | null;
}

interface TransformersModule {
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<EmbeddingPipeline>;
  env: Record<string, unknown>;
}

interface EmbeddingPipeline {
  (texts: string[], options?: Record<string, unknown>): Promise<EmbeddingResult>;
}

interface EmbeddingResult {
  tolist: () => number[][];
}

// ─── Lazy Transformers.js Loading ─────────────────────────────────
// @xenova/transformers is ESM-only, load dynamically
let _transformersModule: TransformersModule | null = null;

async function getTransformers(): Promise<TransformersModule> {
  if (!_transformersModule) {
    _transformersModule = (await import("@xenova/transformers")) as unknown as TransformersModule;
  }
  return _transformersModule;
}

// ─── Embedding Pipeline (cached per process) ──────────────────────
let _embeddingPipeline: EmbeddingPipeline | null = null;

async function getEmbeddingPipeline(): Promise<EmbeddingPipeline> {
  if (!_embeddingPipeline) {
    const { pipeline } = await getTransformers();
    _embeddingPipeline = await pipeline("feature-extraction", BI_ENCODER_MODEL, {
      quantized: true,
    });
  }
  return _embeddingPipeline;
}

// ─── Cross-encoder Pipeline (cached per process) ──────────────────
let _crossEncoderPipeline: EmbeddingPipeline | null = null;

async function getCrossEncoderPipeline(): Promise<EmbeddingPipeline> {
  if (!_crossEncoderPipeline) {
    const { pipeline } = await getTransformers();
    // @xenova/transformers doesn't have a native cross-encoder task,
    // but we can use text-classification for cross-encoder scoring
    _crossEncoderPipeline = await pipeline(
      "text-classification",
      CROSS_ENCODER_MODEL,
      { quantized: true },
    ) as unknown as EmbeddingPipeline;
  }
  return _crossEncoderPipeline;
}

// ─── Math Utilities ────────────────────────────────────────────────
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

// ─── Embedding Computation ────────────────────────────────────────
async function computeEmbeddings(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  const pipe = await getEmbeddingPipeline();
  const embeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    // E5 models require "query: " prefix
    const prepared = batch.map((t) => `query: ${t}`);
    const result = await pipe(prepared, { pooling: "mean", normalize: true });
    const batchEmbeddings = result.tolist();
    for (const emb of batchEmbeddings) {
      embeddings.push(normalize(emb));
    }
    onProgress?.(Math.min(i + batch.length, texts.length), texts.length);
  }

  return embeddings;
}

// ─── Cosine Similarity Matrix ─────────────────────────────────────
export function buildSimilarityMatrix(embeddings: number[][]): number[][] {
  const n = embeddings.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1.0;
    for (let j = i + 1; j < n; j++) {
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      matrix[i][j] = sim;
      matrix[j][i] = sim;
    }
  }
  return matrix;
}

// ─── Density-Based Clustering (simplified HDBSCAN) ────────────────
// Uses mutual reachability distance + single-linkage then cuts tree
export function densityCluster(
  embeddings: number[][],
  minClusterSize: number,
  selectionMethod: "eom" | "leaf" = "eom",
  minSamples: number = 1,
): number[] {
  const n = embeddings.length;
  if (n < minClusterSize) return new Array(n).fill(-1);

  // Compute distance matrix (1 - cosine similarity)
  const dist: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = 1 - cosineSimilarity(embeddings[i], embeddings[j]);
      dist[i][j] = d;
      dist[j][i] = d;
    }
  }

  // Compute core distances (distance to k-th nearest neighbor)
  const k = Math.min(minSamples, n - 1);
  const coreDist = new Array(n);
  for (let i = 0; i < n; i++) {
    const dists = dist[i].filter((_, j) => j !== i).sort((a, b) => a - b);
    coreDist[i] = dists[k - 1] ?? 0;
  }

  // Mutual reachability distance
  const mrd: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.max(coreDist[i], coreDist[j], dist[i][j]);
      mrd[i][j] = d;
      mrd[j][i] = d;
    }
  }

  // Single-linkage clustering via Prim's MST
  const inTree = new Array(n).fill(false);
  const minDist = new Array(n).fill(Infinity);
  const mergeOrder: Array<{ i: number; j: number; dist: number }> = [];
  const nearestInTree = new Array(n).fill(0);

  // Start from node 0
  inTree[0] = true;
  for (let j = 1; j < n; j++) {
    minDist[j] = mrd[0][j];
    nearestInTree[j] = 0;
  }

  for (let step = 0; step < n - 1; step++) {
    // Find closest node not in tree
    let bestNode = -1;
    let bestDist = Infinity;
    for (let j = 0; j < n; j++) {
      if (!inTree[j] && minDist[j] < bestDist) {
        bestDist = minDist[j];
        bestNode = j;
      }
    }

    if (bestNode === -1) break;

    inTree[bestNode] = true;
    mergeOrder.push({ i: nearestInTree[bestNode], j: bestNode, dist: bestDist });

    // Update distances
    for (let j = 0; j < n; j++) {
      if (!inTree[j] && mrd[bestNode][j] < minDist[j]) {
        minDist[j] = mrd[bestNode][j];
        nearestInTree[j] = bestNode;
      }
    }
  }

  // Sort merges by distance
  mergeOrder.sort((a, b) => a.dist - b.dist);

  // Union-Find for cluster extraction
  const parent = Array.from({ length: n }, (_, i) => i);
  const size = new Array(n).fill(1);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (size[ra] < size[rb]) {
      parent[ra] = rb;
      size[rb] += size[ra];
    } else {
      parent[rb] = ra;
      size[ra] += size[rb];
    }
  }

  // Apply merges - use adaptive distance threshold
  // Take the median merge distance as a baseline, go up to 1.5x for eom
  if (mergeOrder.length === 0) return new Array(n).fill(-1);

  const distances = mergeOrder.map((m) => m.dist);
  const medianDist = distances[Math.floor(distances.length / 2)];

  // For "eom", use a more permissive threshold; for "leaf", be stricter
  const cutoff =
    selectionMethod === "eom"
      ? Math.min(medianDist * 1.5, 0.5) // Cap at 0.5 distance (0.5 cosine similarity)
      : Math.min(medianDist * 1.0, 0.35);

  for (const merge of mergeOrder) {
    if (merge.dist <= cutoff) {
      union(merge.i, merge.j);
    }
  }

  // Extract cluster labels
  const clusterMap = new Map<number, number>();
  let nextLabel = 0;
  const labels = new Array(n);
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!clusterMap.has(root)) {
      clusterMap.set(root, nextLabel++);
    }
    labels[i] = clusterMap.get(root)!;
  }

  // Filter out small clusters (set to -1 noise)
  const clusterSizes = new Map<number, number>();
  for (const l of labels) {
    clusterSizes.set(l, (clusterSizes.get(l) ?? 0) + 1);
  }

  for (let i = 0; i < n; i++) {
    if ((clusterSizes.get(labels[i]) ?? 0) < minClusterSize) {
      labels[i] = -1;
    }
  }

  return labels;
}

// ─── Cross-Encoder Verification ────────────────────────────────────
async function verifyClustersWithCrossEncoder(
  texts: string[],
  clusters: Map<number, number[]>,
  threshold: number,
): Promise<Map<number, number[][]>> {
  let classifier: Awaited<ReturnType<typeof getCrossEncoderPipeline>>;
  try {
    classifier = await getCrossEncoderPipeline();
  } catch {
    // If cross-encoder can't load, return clusters as-is (each cluster = 1 component)
    logStageEvent("similarity", "warn", "cross_encoder_unavailable", "Cross-encoder not available, skipping verification");
    const result = new Map<number, number[][]>();
    for (const [label, members] of clusters) {
      result.set(label, [members]);
    }
    return result;
  }

  const result = new Map<number, number[][]>();

  for (const [label, members] of clusters) {
    if (members.length < 2) continue;

    // Build adjacency via pairwise cross-encoder scoring
    const adjacency = new Map<number, Set<number>>();
    for (const m of members) adjacency.set(m, new Set());

    // Score pairs (limit to prevent combinatorial explosion)
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < Math.min(members.length, i + 51); j++) {
        try {
          const pair = `${texts[members[i]]} [SEP] ${texts[members[j]]}`;
          const scores = (await classifier([pair])) as unknown as Array<{
            label: string;
            score: number;
          }>;
          // Cross-encoder scores: higher = more similar
          const score = scores[0]?.score ?? 0;
          if (score >= threshold) {
            adjacency.get(members[i])!.add(members[j]);
            adjacency.get(members[j])!.add(members[i]);
          }
        } catch {
          // On scoring failure, assume similar (conservative)
          adjacency.get(members[i])!.add(members[j]);
          adjacency.get(members[j])!.add(members[i]);
        }
      }
    }

    // Find connected components via BFS
    const visited = new Set<number>();
    const components: number[][] = [];

    for (const start of members) {
      if (visited.has(start)) continue;
      const component: number[] = [];
      const queue = [start];
      while (queue.length > 0) {
        const node = queue.shift()!;
        if (visited.has(node)) continue;
        visited.add(node);
        component.push(node);
        for (const neighbor of adjacency.get(node) ?? []) {
          if (!visited.has(neighbor)) queue.push(neighbor);
        }
      }
      if (component.length >= 2) {
        components.push(component);
      }
    }

    if (components.length > 0) {
      result.set(label, components);
    }
  }

  return result;
}

// ─── Group Questions by Category ──────────────────────────────────
export function groupByCategory(
  questions: CategorizedQuestionEntry[],
): Map<string, Array<{ idx: number; question: CategorizedQuestionEntry }>> {
  const groups = new Map<string, Array<{ idx: number; question: CategorizedQuestionEntry }>>();
  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    const cat = q.categorization;
    if (cat?.success && cat.category) {
      if (!groups.has(cat.category)) groups.set(cat.category, []);
      groups.get(cat.category)!.push({ idx, question: q });
    }
  }
  return groups;
}

// ─── Stage 1: Initial Similarity Detection ────────────────────────
async function runStage1(
  questions: CategorizedQuestionEntry[],
  crossEncoderThreshold: number,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const categoryGroups = groupByCategory(questions);
  console.log(`[similarity] Stage 1: ${categoryGroups.size} categories`);

  let processedCategories = 0;
  const totalCategories = categoryGroups.size;
  let globalGroupCounter = 0;

  for (const [category, entries] of categoryGroups) {
    if (entries.length < 2) {
      processedCategories++;
      onProgress?.(processedCategories, totalCategories);
      continue;
    }

    const texts = entries.map((e) => e.question.data?.question_text ?? "");
    const validEntries = entries.filter((_, i) => texts[i].trim().length > 0);
    const validTexts = validEntries.map((e) => e.question.data?.question_text ?? "");

    if (validEntries.length < 2) {
      processedCategories++;
      onProgress?.(processedCategories, totalCategories);
      continue;
    }

    // Compute embeddings
    const embeddings = await computeEmbeddings(validTexts);

    // Density-based clustering
    const clusterLabels = densityCluster(embeddings, MIN_CLUSTER_SIZE, "eom", 1);

    // Group by cluster label
    const clusters = new Map<number, number[]>();
    for (let i = 0; i < clusterLabels.length; i++) {
      if (clusterLabels[i] >= 0) {
        if (!clusters.has(clusterLabels[i])) clusters.set(clusterLabels[i], []);
        clusters.get(clusterLabels[i])!.push(i);
      }
    }

    // Cross-encoder verification
    const verifiedComponents = await verifyClustersWithCrossEncoder(
      validTexts,
      clusters,
      crossEncoderThreshold,
    );

    // Assign group IDs
    const categoryPrefix = category.replace(/\s+/g, "_").slice(0, 20);
    for (const components of verifiedComponents.values()) {
      for (const component of components) {
        globalGroupCounter++;
        const groupId = `${categoryPrefix}_sim_group_${globalGroupCounter}`;
        for (const localIdx of component) {
          const entry = validEntries[localIdx];
          questions[entry.idx].similarity_group_id = groupId;
        }
      }
    }

    processedCategories++;
    onProgress?.(processedCategories, totalCategories);
  }

  trackSimilarityGroups(globalGroupCounter);
  logStageEvent("similarity", "info", "stage1_complete", `${globalGroupCounter} groups found across ${categoryGroups.size} categories`, { groupCount: globalGroupCounter });
}

// ─── Stage 2: Refinement of Large Groups ──────────────────────────
async function runStage2(
  questions: CategorizedQuestionEntry[],
  refineThreshold: number,
): Promise<void> {
  // Find large groups
  const groups = new Map<string, number[]>();
  for (let idx = 0; idx < questions.length; idx++) {
    const gid = questions[idx].similarity_group_id;
    if (gid) {
      if (!groups.has(gid)) groups.set(gid, []);
      groups.get(gid)!.push(idx);
    }
  }

  const largeGroups = new Map<string, number[]>();
  for (const [gid, indices] of groups) {
    if (indices.length > refineThreshold) {
      largeGroups.set(gid, indices);
    }
  }

  if (largeGroups.size === 0) {
    console.log(`[similarity] No groups > ${refineThreshold} items, skipping refinement`);
    return;
  }

  console.log(`[similarity] Stage 2: Refining ${largeGroups.size} large groups`);

  let groupsSplit = 0;
  let groupsKept = 0;

  for (const [groupId, indices] of largeGroups) {
    if (indices.length < 4) {
      groupsKept++;
      continue;
    }

    const texts = indices.map((i) => questions[i].data?.question_text ?? "");
    const embeddings = await computeEmbeddings(texts);

    // Try with stricter "leaf" clustering
    const clusterLabels = densityCluster(embeddings, 2, "leaf", 2);
    const uniqueLabels = new Set(clusterLabels.filter((l) => l >= 0));

    if (uniqueLabels.size <= 1) {
      // Can't split further with clustering, try hierarchical via similarity matrix
      const simMatrix = buildSimilarityMatrix(embeddings);
      const splitResult = trySplitWithHierarchical(
        simMatrix,
        REFINE_CROSS_ENCODER_THRESHOLD,
      );

      if (splitResult && splitResult.size > 1) {
        groupsSplit++;
        let subGroupNum = 0;
        for (const members of splitResult.values()) {
          subGroupNum++;
          for (const localIdx of members) {
            questions[indices[localIdx]].similarity_group_id =
              `${groupId}_sub${subGroupNum}`;
          }
        }
        // Unassign items not in any sub-group
        const assigned = new Set<number>();
        for (const members of splitResult.values()) {
          for (const m of members) assigned.add(m);
        }
        for (let i = 0; i < indices.length; i++) {
          if (!assigned.has(i)) {
            questions[indices[i]].similarity_group_id = null;
          }
        }
      } else {
        groupsKept++;
      }
    } else {
      // Multiple sub-clusters found
      groupsSplit++;
      let subGroupNum = 0;
      const clusterMembers = new Map<number, number[]>();
      for (let i = 0; i < clusterLabels.length; i++) {
        if (clusterLabels[i] >= 0) {
          if (!clusterMembers.has(clusterLabels[i]))
            clusterMembers.set(clusterLabels[i], []);
          clusterMembers.get(clusterLabels[i])!.push(i);
        }
      }

      for (const members of clusterMembers.values()) {
        if (members.length >= 2) {
          subGroupNum++;
          for (const localIdx of members) {
            questions[indices[localIdx]].similarity_group_id =
              `${groupId}_sub${subGroupNum}`;
          }
        }
      }

      // Unassign noise points
      for (let i = 0; i < clusterLabels.length; i++) {
        if (clusterLabels[i] < 0) {
          questions[indices[i]].similarity_group_id = null;
        }
      }
    }
  }

  console.log(
    `[similarity] Stage 2 complete: ${groupsSplit} split, ${groupsKept} kept`,
  );
}

// ─── Hierarchical Split (fallback for Stage 2) ────────────────────
export function trySplitWithHierarchical(
  simMatrix: number[][],
  threshold: number,
): Map<number, number[]> | null {
  const n = simMatrix.length;
  if (n < 4) return null;

  // Agglomerative clustering using average linkage
  // Start with each point as its own cluster
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) clusters.set(i, [i]);

  const activeClusters = new Set<number>(clusters.keys());

  // Find minimum distance between clusters (average linkage)
  while (activeClusters.size > 1) {
    let bestI = -1;
    let bestJ = -1;
    let bestDist = Infinity;

    const active = Array.from(activeClusters);
    for (let ai = 0; ai < active.length; ai++) {
      for (let aj = ai + 1; aj < active.length; aj++) {
        const ci = clusters.get(active[ai])!;
        const cj = clusters.get(active[aj])!;

        // Average linkage distance (1 - avg similarity)
        let totalSim = 0;
        for (const mi of ci) {
          for (const mj of cj) {
            totalSim += simMatrix[mi][mj];
          }
        }
        const avgDist = 1 - totalSim / (ci.length * cj.length);

        if (avgDist < bestDist) {
          bestDist = avgDist;
          bestI = active[ai];
          bestJ = active[aj];
        }
      }
    }

    // Stop merging if distance exceeds threshold
    if (bestDist > 1 - threshold) break;

    // Merge bestJ into bestI
    const merged = [...clusters.get(bestI)!, ...clusters.get(bestJ)!];
    clusters.set(bestI, merged);
    clusters.delete(bestJ);
    activeClusters.delete(bestJ);
  }

  // Filter out singleton clusters
  const result = new Map<number, number[]>();
  let clusterIdx = 0;
  for (const members of clusters.values()) {
    if (members.length >= 2) {
      result.set(clusterIdx++, members);
    }
  }

  return result.size > 1 ? result : null;
}

// ─── Statistics ───────────────────────────────────────────────────
function printStats(questions: CategorizedQuestionEntry[], title: string): void {
  const groups = new Map<string, number[]>();
  for (let idx = 0; idx < questions.length; idx++) {
    const gid = questions[idx].similarity_group_id;
    if (gid) {
      if (!groups.has(gid)) groups.set(gid, []);
      groups.get(gid)!.push(idx);
    }
  }

  if (groups.size === 0) {
    console.log(`[similarity] ${title}: No groups found`);
    return;
  }

  const sizes = Array.from(groups.values()).map((v) => v.length);
  const totalAssigned = sizes.reduce((a, b) => a + b, 0);

  console.log(`[similarity] ${title}:`);
  console.log(`  Total questions: ${questions.length}`);
  console.log(`  With similarity group: ${totalAssigned}`);
  console.log(`  Without group: ${questions.length - totalAssigned}`);
  console.log(`  Unique groups: ${groups.size}`);
  console.log(`  Largest group: ${Math.max(...sizes)}`);
  console.log(`  Smallest group: ${Math.min(...sizes)}`);
  console.log(`  Avg group size: ${(totalAssigned / groups.size).toFixed(2)}`);
}

// ─── BullMQ Processor ─────────────────────────────────────────────
async function processSimilarity(
  job: Job<SimilarityJobData>,
): Promise<{
  totalQuestions: number;
  groupsFound: number;
  questionsAssigned: number;
  outputPath: string;
}> {
  const {
    tenantId,
    pipelineRunId,
    inputPath,
    outputPath,
    crossEncoderThreshold = DEFAULT_CROSS_ENCODER_THRESHOLD,
    refineThreshold = DEFAULT_REFINE_THRESHOLD,
  } = job.data;
  const db = getDb();

  logStageEvent("similarity", "info", "job_started", `Processing questions from ${inputPath}`, { tenantId, pipelineRunId });

  // Update job status to active
  await db.pipelineJob.updateMany({
    where: { pipelineRunId, stage: PipelineStage.SIMILARITY },
    data: { status: "ACTIVE", startedAt: new Date() },
  });

  try {
    // Delete pre-existing similarity output and split directory for clean state
    // (important for merged pipelines that re-run similarity from scratch)
    await rm(outputPath, { force: true });
    await rm(path.join(path.dirname(outputPath), "split"), { recursive: true, force: true });

    // Load categorized questions
    const raw = await readFile(inputPath, "utf-8");
    const questions: CategorizedQuestionEntry[] = JSON.parse(raw);

    logStageEvent("similarity", "info", "questions_loaded", `Loaded ${questions.length} questions`, { questionCount: questions.length });

    // Initialize all similarity_group_id to null
    for (const q of questions) {
      q.similarity_group_id = null;
    }

    if (questions.length < 2) {
      logStageEvent("similarity", "info", "too_few_questions", `Only ${questions.length} questions, skipping similarity analysis`, { pipelineRunId });

      const emptyResult = {
        totalQuestions: questions.length,
        groupsFound: 0,
        questionsAssigned: 0,
        outputPath,
      };

      await writeFile(outputPath, JSON.stringify(questions, null, 2), "utf-8");

      await db.pipelineJob.updateMany({
        where: { pipelineRunId, stage: PipelineStage.SIMILARITY },
        data: {
          status: "COMPLETED",
          progress: 100,
          completedAt: new Date(),
          result: emptyResult,
        },
      });

      // Still enqueue next stage so pipeline completes
      const nextJobData: CategorySplitJobData = {
        tenantId,
        pipelineRunId,
        inputPath: outputPath,
        outputDir: path.join(path.dirname(outputPath), "split"),
      };
      await addJob(
        PipelineStage.CATEGORY_SPLIT,
        nextJobData as unknown as Record<string, unknown>,
      );
      await db.pipelineJob.create({
        data: {
          pipelineRunId,
          stage: PipelineStage.CATEGORY_SPLIT,
          status: "PENDING",
        },
      });
      await db.pipelineRun.update({
        where: { id: pipelineRunId },
        data: { currentStage: PipelineStage.CATEGORY_SPLIT },
      });

      return emptyResult;
    }

    // Stage 1: Initial similarity detection
    await runStage1(questions, crossEncoderThreshold, async (done, total) => {
      // Stage 1 is 0-70% of progress
      const progress = Math.round((done / total) * 70);
      await job.updateProgress(progress);
      await db.pipelineJob.updateMany({
        where: { pipelineRunId, stage: PipelineStage.SIMILARITY },
        data: { progress },
      });
    });

    printStats(questions, "After Stage 1");

    // Stage 2: Refinement
    await runStage2(questions, refineThreshold);
    await job.updateProgress(90);

    printStats(questions, "After Stage 2 (Final)");

    // Save output
    await writeFile(outputPath, JSON.stringify(questions, null, 2), "utf-8");
    await job.updateProgress(100);

    // Count results
    const groups = new Set<string>();
    let assigned = 0;
    for (const q of questions) {
      if (q.similarity_group_id) {
        groups.add(q.similarity_group_id);
        assigned++;
      }
    }

    const result = {
      totalQuestions: questions.length,
      groupsFound: groups.size,
      questionsAssigned: assigned,
      outputPath,
    };

    // Update job status to completed
    await db.pipelineJob.updateMany({
      where: { pipelineRunId, stage: PipelineStage.SIMILARITY },
      data: {
        status: "COMPLETED",
        progress: 100,
        completedAt: new Date(),
        result,
      },
    });

    // Enqueue next stage: category-split
    const nextJobData: CategorySplitJobData = {
      tenantId,
      pipelineRunId,
      inputPath: outputPath,
      outputDir: path.join(path.dirname(outputPath), "split"),
    };
    await addJob(
      PipelineStage.CATEGORY_SPLIT,
      nextJobData as unknown as Record<string, unknown>,
    );

    // Create pipeline job record for next stage
    await db.pipelineJob.create({
      data: {
        pipelineRunId,
        stage: PipelineStage.CATEGORY_SPLIT,
        status: "PENDING",
      },
    });

    await db.pipelineRun.update({
      where: { id: pipelineRunId },
      data: { currentStage: PipelineStage.CATEGORY_SPLIT },
    });

    logStageEvent("similarity", "info", "job_completed", `${groups.size} groups, ${assigned}/${questions.length} questions assigned`, { pipelineRunId, groupCount: groups.size, assignedCount: assigned });
    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logStageEvent("similarity", "error", "job_failed", errorMsg, { pipelineRunId });

    // Update job status to failed
    await db.pipelineJob.updateMany({
      where: { pipelineRunId, stage: PipelineStage.SIMILARITY },
      data: {
        status: "FAILED",
        errorMessage: errorMsg,
      },
    });

    // Mark pipeline run as failed
    await db.pipelineRun.update({
      where: { id: pipelineRunId },
      data: { status: "FAILED", errorMessage: errorMsg },
    });

    throw err;
  }
}

// ─── Worker Registration ──────────────────────────────────────────
export function createSimilarityWorker(): Worker<SimilarityJobData> {
  const config = getConfig();
  const worker = createWorker<SimilarityJobData>(
    PipelineStage.SIMILARITY,
    processSimilarity,
    { concurrency: config.WORKER_CONCURRENCY },
  );

  worker.on("completed", (job) => {
    console.log(`[similarity] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[similarity] Job ${job?.id} failed:`, err.message);
  });

  console.log("[similarity] Worker registered");
  return worker;
}
