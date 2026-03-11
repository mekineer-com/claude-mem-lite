// claude-mem-lite: Resource indexer — extracts metadata via Haiku LLM
// Called during installation and when resource content changes

import { upsertResource } from './registry.mjs';
import { callHaikuJSON } from './haiku-client.mjs';
import { debugLog, debugCatch, truncate } from './utils.mjs';

// ─── Index Prompt ────────────────────────────────────────────────────────────

/**
 * Build the LLM prompt for extracting structured metadata from a resource.
 * @param {object} resource Scanned resource with name, type, and content
 * @returns {string} Prompt string for Haiku JSON extraction
 */
function buildIndexPrompt(resource) {
  const content = truncate(resource.content, 3000);
  return `Analyze this Claude Code ${resource.type} definition and extract structured metadata.
Return ONLY valid JSON, no markdown fences.

<resource-name>${resource.name}</resource-name>
<resource-type>${resource.type}</resource-type>
<content>
${content}
</content>

JSON format:
{"intent_tags":"comma-separated intent keywords (e.g. test,debug,deploy,review)","domain_tags":"comma-separated tech/language tags (e.g. javascript,react,python)","action_type":"analyze|generate|transform|validate|deploy|configure|review","trigger_patterns":"natural language describing when to use this (e.g. when user needs to write tests; when debugging errors)","capability_summary":"50-100 char description of what it does","input_type":"code|file|directory|url|text","output_type":"report|file|diff|terminal_output|analysis"}`;
}

// ─── Fallback Extraction ─────────────────────────────────────────────────────

/**
 * Extract basic metadata from resource content using regex when Haiku fails.
 * Better than nothing — provides minimal FTS5 searchability.
 */
function fallbackExtract(resource) {
  const content = (resource.content || '').toLowerCase();
  const name = resource.name.toLowerCase();

  // Infer intent tags from name and common patterns
  const intentMap = {
    commit: 'commit,git,version-control',
    test: 'test,testing,tdd,qa',
    debug: 'debug,troubleshoot,fix,error',
    review: 'review,code-review,quality',
    lint: 'lint,format,style,quality',
    deploy: 'deploy,release,ci,cd',
    build: 'build,compile,bundle',
    refactor: 'refactor,clean,simplify',
    security: 'security,audit,vulnerability',
    perf: 'performance,optimize,benchmark',
    doc: 'documentation,readme,docs',
    design: 'design,ui,ux,frontend',
    infra: 'infrastructure,devops,cloud',
  };

  const intentTagSet = new Set();
  for (const [key, tags] of Object.entries(intentMap)) {
    if (name.includes(key) || content.includes(key)) {
      for (const t of tags.split(',')) intentTagSet.add(t);
    }
  }
  const intentTags = [...intentTagSet].join(',');

  // Infer domain tags from content
  const domainPatterns = [
    [/\b(javascript|typescript|node|npm|yarn|pnpm)\b/, 'javascript,typescript,node'],
    [/\b(python|pip|poetry|django|flask)\b/, 'python'],
    [/\b(react|vue|angular|svelte|next)\b/, 'frontend,javascript'],
    [/\b(rust|cargo)\b/, 'rust'],
    [/\b(go|golang)\b/, 'go'],
    [/\b(docker|kubernetes|k8s|terraform)\b/, 'infrastructure,devops'],
    [/\b(postgres|mysql|sqlite|mongodb)\b/, 'database'],
    [/\b(api|rest|graphql|grpc)\b/, 'api,backend'],
  ];

  let domainTags = '';
  for (const [pattern, tags] of domainPatterns) {
    if (pattern.test(content)) {
      domainTags = domainTags ? `${domainTags},${tags}` : tags;
    }
  }

  return {
    intent_tags: intentTags || resource.type,
    domain_tags: domainTags || 'general',
    action_type: resource.type === 'agent' ? 'analyze' : 'generate',
    trigger_patterns: `when user needs ${name.replace(/-/g, ' ')} functionality`,
    capability_summary: truncate(`${resource.type}: ${name.replace(/-/g, ' ')}`, 100),
    input_type: 'code',
    output_type: resource.type === 'agent' ? 'analysis' : 'file',
  };
}

// ─── Single Resource Indexing ────────────────────────────────────────────────

/**
 * Index a single resource: call Haiku for metadata, then upsert to DB.
 * Falls back to regex extraction if Haiku fails.
 * @param {Database} db Registry database
 * @param {object} resource Scanned resource object
 * @returns {Promise<number>} Resource ID
 */
export async function indexResource(db, resource) {
  const prompt = buildIndexPrompt(resource);
  let metadata = await callHaikuJSON(prompt, { timeout: 15000, maxTokens: 400 });

  if (!metadata || !metadata.capability_summary) {
    debugLog('WARN', 'indexer', `Haiku failed for ${resource.name}, using fallback`);
    metadata = fallbackExtract(resource);
  }

  const now = new Date().toISOString();
  const id = upsertResource(db, {
    name: resource.name,
    type: resource.type,
    status: 'active',
    source: resource.source,
    repo_url: resource.repoUrl || null,
    repo_stars: resource.repoStars || 0,
    local_path: resource.localPath,
    file_hash: resource.fileHash,
    intent_tags: metadata.intent_tags || '',
    domain_tags: metadata.domain_tags || '',
    action_type: metadata.action_type || '',
    trigger_patterns: metadata.trigger_patterns || '',
    capability_summary: metadata.capability_summary || '',
    input_type: metadata.input_type || '',
    output_type: metadata.output_type || '',
    prerequisites: typeof metadata.prerequisites === 'object'
      ? JSON.stringify(metadata.prerequisites) : '{}',
    indexed_at: now,
  });

  return id;
}

/**
 * Index multiple resources sequentially.
 * Logs progress and continues on individual failures.
 * @param {Database} db Registry database
 * @param {object[]} resources Array of scanned resources
 * @returns {Promise<{indexed: number, failed: number}>} Results summary
 */
export async function indexAll(db, resources) {
  let indexed = 0;
  let failed = 0;

  for (const resource of resources) {
    try {
      await indexResource(db, resource);
      indexed++;
      debugLog('DEBUG', 'indexer', `indexed: ${resource.type}/${resource.name}`);
    } catch (e) {
      failed++;
      debugCatch(e, `indexResource(${resource.name})`);
      // Mark as error in DB so it can be retried later
      try {
        upsertResource(db, {
          name: resource.name,
          type: resource.type,
          status: 'error',
          source: resource.source,
          local_path: resource.localPath,
          file_hash: resource.fileHash,
        });
      } catch {}
    }
  }

  return { indexed, failed };
}
