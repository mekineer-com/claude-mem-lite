#!/usr/bin/env node
// claude-mem-lite Installer — Smart install/uninstall/status/doctor

import { execSync, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, copyFileSync, cpSync, renameSync, symlinkSync, unlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const PROJECT_DIR = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)));
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const DATA_DIR = join(homedir(), '.claude-mem-lite');
const DB_PATH = join(DATA_DIR, 'claude-mem-lite.db');
const OLD_DATA_DIR = join(homedir(), '.claude-mem');

// Detect ephemeral context (npx) — files won't persist after exit
const IS_NPX = process.env.npm_command === 'exec' ||
  PROJECT_DIR.includes('_npx') || PROJECT_DIR.includes('.npm/_');

// Both modes install to ~/.claude-mem-lite/ (copies or symlinks)
const INSTALL_DIR = DATA_DIR;
const SERVER_PATH = join(INSTALL_DIR, 'server.mjs');
const HOOK_PATH = join(INSTALL_DIR, 'hook.mjs');

// ─── Curated Resource Metadata ───────────────────────────────────────────────
// Replaces generic name-echo fallback with FTS5-optimized metadata per resource.
// Keys: intent_tags, domain_tags, capability_summary, trigger_patterns

const RESOURCE_METADATA = {
  // ─── Skills ──────────────────────────────────────────────────────────────
  'skill:skill-creator': {
    intent_tags: 'skill,create,extend,meta,develop,author',
    domain_tags: 'claude,skill,markdown',
    capability_summary: 'Guide for creating and authoring new Claude Code skills with proper structure and metadata',
    trigger_patterns: 'when user wants to create a new skill or extend Claude capabilities with custom workflows',
  },
  'skill:frontend-design': {
    intent_tags: 'design,ui,ux,frontend,css,component,layout,styling,interface',
    domain_tags: 'css,react,html,tailwind,frontend',
    capability_summary: 'Create distinctive production-grade frontend interfaces with high design quality',
    trigger_patterns: 'when user needs to build or design UI components pages or web interfaces',
  },
  'skill:webapp-testing': {
    intent_tags: 'test,webapp,e2e,browser,qa,selenium,cypress,integration',
    domain_tags: 'browser,web,testing',
    capability_summary: 'Web application testing with browser automation and E2E test suites',
    trigger_patterns: 'when user needs to test web applications in a browser or write E2E tests',
  },
  'skill:mcp-builder': {
    intent_tags: 'mcp,server,tool,integration,build,protocol,plugin',
    domain_tags: 'mcp,node,typescript',
    capability_summary: 'Build MCP servers and tool integrations for Claude Code',
    trigger_patterns: 'when user wants to build an MCP server or create tool integrations',
  },
  'skill:pdf': {
    intent_tags: 'pdf,document,generate,export,report,print',
    domain_tags: 'pdf,document',
    capability_summary: 'Generate and export PDF documents from content',
    trigger_patterns: 'when user needs to create generate or export PDF documents',
  },
  'skill:doc-coauthoring': {
    intent_tags: 'documentation,writing,collaborate,docs,readme,technical-writing',
    domain_tags: 'markdown,docs,documentation',
    capability_summary: 'Collaborative documentation writing and technical content authoring',
    trigger_patterns: 'when user needs help writing documentation README or technical content',
  },
  'skill:superpowers-brainstorming': {
    intent_tags: 'brainstorm,design,planning,creative,ideas,explore,requirements',
    domain_tags: 'planning,design',
    capability_summary: 'Explore user intent requirements and design before implementation through structured brainstorming',
    trigger_patterns: 'when user needs to brainstorm ideas explore requirements or plan creative solutions before coding',
  },
  'skill:superpowers-tdd': {
    intent_tags: 'test,tdd,testing,unittest,spec,coverage,quality,red-green-refactor',
    domain_tags: 'testing,javascript,typescript,python',
    capability_summary: 'Test-driven development workflow with red-green-refactor cycle and quality checks',
    trigger_patterns: 'when user wants to write tests first or follow TDD methodology for feature development',
  },
  'skill:superpowers-debugging': {
    intent_tags: 'debug,troubleshoot,fix,error,systematic,diagnose,bug,crash,failure',
    domain_tags: 'debugging,error-handling',
    capability_summary: 'Systematic debugging approach for complex bugs using hypothesis-driven investigation',
    trigger_patterns: 'when user encounters bugs errors crashes or unexpected behavior that needs systematic debugging',
  },
  'skill:superpowers-code-review': {
    intent_tags: 'review,code-review,quality,audit,feedback,inspect,pr-review',
    domain_tags: 'quality,review',
    capability_summary: 'Structured code review requesting with quality checklists and feedback gathering',
    trigger_patterns: 'when user wants to request or perform a thorough code review of their changes',
  },
  'skill:superpowers-writing-plans': {
    intent_tags: 'plan,architecture,spec,implementation,blueprint,roadmap,strategy',
    domain_tags: 'planning,architecture',
    capability_summary: 'Write structured implementation plans from specs before touching code',
    trigger_patterns: 'when user has requirements or specs and needs a multi-step implementation plan before coding',
  },
  'skill:superpowers-git-worktrees': {
    intent_tags: 'git,worktree,branch,isolation,parallel,workspace',
    domain_tags: 'git,workflow',
    capability_summary: 'Create isolated git worktrees for parallel feature development',
    trigger_patterns: 'when user needs to work on multiple branches simultaneously or isolate feature work',
  },
  'skill:superpowers-verification': {
    intent_tags: 'verify,check,test,complete,quality,validation,evidence',
    domain_tags: 'quality,verification',
    capability_summary: 'Verify work is complete by running checks and gathering evidence before claiming done',
    trigger_patterns: 'when user is about to claim work is complete and needs verification before committing',
  },
  'skill:playwright-skill': {
    intent_tags: 'playwright,browser,automation,test,e2e,screenshot,scrape',
    domain_tags: 'playwright,browser,testing',
    capability_summary: 'Browser automation with Playwright for testing forms screenshots and web interactions',
    trigger_patterns: 'when user needs to automate browser interactions test web pages or take screenshots with Playwright',
  },
  'skill:planning-with-files': {
    intent_tags: 'plan,files,organize,structure,project,scope',
    domain_tags: 'planning,project',
    capability_summary: 'Plan project structure and organize files before implementation',
    trigger_patterns: 'when user needs to plan file structure or organize project layout before building',
  },
  'skill:code-review-expert': {
    intent_tags: 'review,code-review,expert,quality,SOLID,security,architecture',
    domain_tags: 'quality,review,security',
    capability_summary: 'Expert code review detecting SOLID violations security risks and architectural issues',
    trigger_patterns: 'when user needs expert-level code review with SOLID analysis and security scanning',
  },
  'skill:ui-ux-pro-max': {
    intent_tags: 'ui,ux,design,frontend,pro,interface,visual,styling',
    domain_tags: 'ui,ux,frontend,css',
    capability_summary: 'Professional UI/UX design with polished visual styling and user experience focus',
    trigger_patterns: 'when user needs professional-grade UI/UX design with strong visual polish',
  },
  // ─── Agents ──────────────────────────────────────────────────────────────
  'agent:code-review-ai': {
    intent_tags: 'review,code-review,ai,quality,audit,automated',
    domain_tags: 'quality,review',
    capability_summary: 'AI-powered automated code review with quality analysis and improvement suggestions',
    trigger_patterns: 'when user wants AI-automated code review or quality analysis of their codebase',
  },
  'agent:tdd-workflows': {
    intent_tags: 'test,tdd,workflow,testing,quality,unittest,spec',
    domain_tags: 'testing,tdd',
    capability_summary: 'Automated TDD workflow agent for test-first development cycles',
    trigger_patterns: 'when user wants automated TDD workflow support with test generation and execution',
  },
  'agent:debugging-toolkit': {
    intent_tags: 'debug,toolkit,error,troubleshoot,fix,diagnose,trace,crash',
    domain_tags: 'debugging,error-handling',
    capability_summary: 'Debugging toolkit agent with error analysis stack trace investigation and fix suggestions',
    trigger_patterns: 'when user has errors or crashes and needs automated debugging assistance and fix suggestions',
  },
  'agent:code-refactoring': {
    intent_tags: 'refactor,clean,simplify,restructure,organize,improve,technical-debt',
    domain_tags: 'refactoring,quality',
    capability_summary: 'Automated code refactoring for cleaner structure reduced complexity and technical debt',
    trigger_patterns: 'when user wants to refactor code simplify complex logic or reduce technical debt',
  },
  'agent:code-documentation': {
    intent_tags: 'documentation,docs,readme,jsdoc,comment,docstring,api-docs',
    domain_tags: 'documentation,docs',
    capability_summary: 'Automated code documentation generation including JSDoc README and API docs',
    trigger_patterns: 'when user needs to generate documentation add JSDoc comments or create README files',
  },
  'agent:security-scanning': {
    intent_tags: 'security,scan,vulnerability,audit,owasp,secrets,xss,injection',
    domain_tags: 'security,audit',
    capability_summary: 'Security vulnerability scanning for OWASP issues secrets leaks and injection flaws',
    trigger_patterns: 'when user needs security scanning for vulnerabilities secrets or OWASP compliance',
  },
  'agent:application-performance': {
    intent_tags: 'performance,optimize,profile,benchmark,speed,latency,memory',
    domain_tags: 'performance,optimization',
    capability_summary: 'Application performance profiling optimization and benchmark analysis',
    trigger_patterns: 'when user needs to profile optimize or benchmark application performance',
  },
  'agent:api-scaffolding': {
    intent_tags: 'api,scaffold,rest,endpoint,backend,route,express,fastify',
    domain_tags: 'api,backend,rest',
    capability_summary: 'Scaffold REST API endpoints with routes controllers and validation boilerplate',
    trigger_patterns: 'when user needs to scaffold new API endpoints or build REST backend structure',
  },
  'agent:database-design': {
    intent_tags: 'database,schema,sql,design,model,erd,table,relation',
    domain_tags: 'database,sql,schema',
    capability_summary: 'Database schema design with table relationships indexes and normalization',
    trigger_patterns: 'when user needs to design database schema create tables or model data relationships',
  },
  'agent:database-migrations': {
    intent_tags: 'database,migration,schema,alter,sql,upgrade,rollback',
    domain_tags: 'database,sql,migration',
    capability_summary: 'Database migration generation with schema alterations upgrade and rollback support',
    trigger_patterns: 'when user needs to create database migrations alter schemas or manage schema versions',
  },
  'agent:cicd-automation': {
    intent_tags: 'ci,cd,automation,pipeline,deploy,github-actions,workflow',
    domain_tags: 'cicd,devops,deploy',
    capability_summary: 'CI/CD pipeline automation with GitHub Actions workflow configuration and deploy setup',
    trigger_patterns: 'when user needs to set up CI/CD pipelines configure GitHub Actions or automate deployments',
  },
  'agent:git-pr-workflows': {
    intent_tags: 'git,pr,pull-request,merge,workflow,branch,commit',
    domain_tags: 'git,workflow',
    capability_summary: 'Git PR workflow automation with branch management commit strategy and merge handling',
    trigger_patterns: 'when user needs help with git PR workflows branch management or merge strategies',
  },
  'agent:unit-testing': {
    intent_tags: 'test,unit,jest,vitest,mocha,pytest,unittest,spec',
    domain_tags: 'testing,unittest',
    capability_summary: 'Unit test generation and execution with jest vitest mocha or pytest',
    trigger_patterns: 'when user needs to write or generate unit tests using jest vitest mocha or pytest',
  },
  'agent:dependency-management': {
    intent_tags: 'dependency,npm,package,update,manage,upgrade,audit,outdated',
    domain_tags: 'dependencies,npm,package',
    capability_summary: 'Dependency management with version updates audit and compatibility checking',
    trigger_patterns: 'when user needs to manage update audit or resolve dependency conflicts',
  },
  'agent:error-debugging': {
    intent_tags: 'error,debug,diagnose,stack-trace,fix,exception,crash,runtime',
    domain_tags: 'debugging,error-handling',
    capability_summary: 'Error diagnosis from stack traces with root cause analysis and fix suggestions',
    trigger_patterns: 'when user has runtime errors exceptions or stack traces that need diagnosis and fixing',
  },
  'agent:python-development': {
    intent_tags: 'python,pip,poetry,django,flask,fastapi,virtualenv',
    domain_tags: 'python,backend',
    capability_summary: 'Python development agent for Django Flask FastAPI and general Python projects',
    trigger_patterns: 'when user is working on Python projects with pip poetry Django Flask or FastAPI',
  },
  'agent:javascript-typescript': {
    intent_tags: 'javascript,typescript,node,npm,web,react,express,fullstack',
    domain_tags: 'javascript,typescript,node,web',
    capability_summary: 'JavaScript and TypeScript development agent for Node.js React and web projects',
    trigger_patterns: 'when user is working on JavaScript TypeScript Node.js or web development projects',
  },
  'agent:cloud-infrastructure': {
    intent_tags: 'cloud,aws,gcp,azure,infrastructure,terraform,iac,devops',
    domain_tags: 'cloud,infrastructure,devops',
    capability_summary: 'Cloud infrastructure management with AWS GCP Azure and Terraform IaC',
    trigger_patterns: 'when user needs to manage cloud infrastructure with AWS GCP Azure or Terraform',
  },
  'agent:ui-design': {
    intent_tags: 'ui,design,frontend,css,component,layout,responsive',
    domain_tags: 'ui,frontend,css',
    capability_summary: 'UI design agent for frontend component layout and responsive design implementation',
    trigger_patterns: 'when user needs to design and implement UI components layouts or responsive interfaces',
  },
  'agent:frontend-developer': {
    intent_tags: 'frontend,react,vue,web,component,spa,interface',
    domain_tags: 'frontend,react,vue,web',
    capability_summary: 'Frontend development agent for React Vue and modern web application building',
    trigger_patterns: 'when user needs to build frontend applications with React Vue or modern web frameworks',
  },
  'agent:mcp-expert': {
    intent_tags: 'mcp,server,tool,integration,protocol,sdk,plugin',
    domain_tags: 'mcp,protocol,integration',
    capability_summary: 'MCP protocol expert for building servers tools and integrations with the MCP SDK',
    trigger_patterns: 'when user needs expert help with MCP protocol server development or tool integration',
  },
  'agent:component-reviewer': {
    intent_tags: 'component,review,quality,frontend,react,vue,audit',
    domain_tags: 'frontend,review,component',
    capability_summary: 'Frontend component reviewer for quality accessibility and best-practice auditing',
    trigger_patterns: 'when user wants to review frontend components for quality accessibility and best practices',
  },
};

/**
 * Apply curated metadata to existing resource DB entries.
 * Fixes existing installs that have generic name-echo metadata.
 * @param {Database} rdb Registry database handle
 */
function reindexKnownResources(rdb) {
  const update = rdb.prepare(`
    UPDATE resources SET
      intent_tags = ?, domain_tags = ?,
      capability_summary = ?, trigger_patterns = ?,
      updated_at = datetime('now')
    WHERE type = ? AND name = ?
  `);

  rdb.transaction(() => {
    for (const [key, meta] of Object.entries(RESOURCE_METADATA)) {
      const [type, name] = key.split(':');
      update.run(
        meta.intent_tags, meta.domain_tags,
        meta.capability_summary, meta.trigger_patterns,
        type, name
      );
    }
  })();
}

const cmd = process.argv[2];
const flags = new Set(process.argv.slice(3));

function log(msg) { console.log(`  ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); }

// ─── Install ────────────────────────────────────────────────────────────────

async function install() {
  console.log('\nclaude-mem-lite installer\n');

  // 1. Install source files to ~/.claude-mem-lite/
  const IS_DEV = flags.has('--dev');

  // Auto-migrate unhidden dir (~/claude-mem-lite/ → ~/.claude-mem-lite/)
  const oldUnhidden = join(homedir(), 'claude-mem-lite');
  if (!existsSync(DATA_DIR) && existsSync(oldUnhidden)) {
    log('Migrating ~/claude-mem-lite/ → ~/.claude-mem-lite/...');
    renameSync(oldUnhidden, DATA_DIR);
    ok('Directory migrated');
  }

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const SOURCE_FILES = [
    'server.mjs', 'server-internals.mjs', 'tool-schemas.mjs',
    'hook.mjs', 'hook-shared.mjs', 'hook-llm.mjs',
    'hook-semaphore.mjs', 'hook-episode.mjs', 'hook-context.mjs',
    'haiku-client.mjs', 'utils.mjs', 'schema.mjs', 'package.json', 'skill.md',
    'registry.mjs', 'registry-scanner.mjs', 'registry-indexer.mjs',
    'registry-retriever.mjs', 'resource-discovery.mjs',
    'dispatch.mjs', 'dispatch-inject.mjs', 'dispatch-feedback.mjs',
  ];

  if (IS_DEV) {
    log('Dev mode — creating symlinks in ~/.claude-mem-lite/...');
    // Symlink individual source files
    for (const f of SOURCE_FILES) {
      const target = join(PROJECT_DIR, f);
      const link = join(DATA_DIR, f);
      if (existsSync(target)) {
        // Remove existing file/symlink before creating
        if (existsSync(link)) try { unlinkSync(link); } catch {}
        symlinkSync(target, link);
      }
    }
    // Symlink scripts/ directory
    const scriptsLink = join(DATA_DIR, 'scripts');
    if (existsSync(scriptsLink)) try { rmSync(scriptsLink, { recursive: true, force: true }); } catch {}
    symlinkSync(join(PROJECT_DIR, 'scripts'), scriptsLink);
    // Symlink node_modules/
    const nmLink = join(DATA_DIR, 'node_modules');
    if (existsSync(nmLink)) try { rmSync(nmLink, { recursive: true, force: true }); } catch {}
    symlinkSync(join(PROJECT_DIR, 'node_modules'), nmLink);
    // Symlink registry/ directory
    const regLink = join(DATA_DIR, 'registry');
    if (existsSync(regLink)) try { rmSync(regLink, { recursive: true, force: true }); } catch {}
    if (existsSync(join(PROJECT_DIR, 'registry'))) {
      symlinkSync(join(PROJECT_DIR, 'registry'), regLink);
    }
    ok('Symlinks created in ~/.claude-mem-lite/ → dev dir');
  } else {
    log('Installing to ~/.claude-mem-lite/...');
    const scriptsDir = join(DATA_DIR, 'scripts');
    if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true });
    for (const f of SOURCE_FILES) {
      const src = join(PROJECT_DIR, f);
      if (existsSync(src)) copyFileSync(src, join(DATA_DIR, f));
    }
    // Copy scripts
    const postToolSrc = join(PROJECT_DIR, 'scripts', 'post-tool-use.sh');
    if (existsSync(postToolSrc)) copyFileSync(postToolSrc, join(scriptsDir, 'post-tool-use.sh'));
    // Ensure bash script is executable
    try { execSync(`chmod +x "${join(scriptsDir, 'post-tool-use.sh')}"`, { stdio: 'pipe' }); } catch {}
    // Copy registry manifest
    const registryDir = join(DATA_DIR, 'registry');
    if (!existsSync(registryDir)) mkdirSync(registryDir, { recursive: true });
    const manifestSrc = join(PROJECT_DIR, 'registry', 'preinstalled.json');
    if (existsSync(manifestSrc)) copyFileSync(manifestSrc, join(registryDir, 'preinstalled.json'));
    ok('Source files copied to ~/.claude-mem-lite/');
  }

  // 2. npm install (skip for --dev: node_modules is symlinked)
  if (IS_DEV) {
    ok('Dependencies: using dev dir (symlinked)');
  } else if (!existsSync(join(INSTALL_DIR, 'node_modules'))) {
    log('Installing dependencies...');
    try {
      execSync('npm install --omit=dev', { cwd: INSTALL_DIR, stdio: 'pipe' });
      ok('Dependencies installed');
    } catch (e) {
      fail('npm install failed: ' + e.message);
      process.exit(1);
    }
  } else {
    ok('Dependencies already installed');
  }

  // 3. Register MCP server
  log('Registering MCP server...');
  try {
    // Remove existing first (ignore errors)
    try { execFileSync('claude', ['mcp', 'remove', '-s', 'user', 'mem'], { stdio: 'pipe' }); } catch {}
    execFileSync('claude', ['mcp', 'add', '-s', 'user', '-t', 'stdio', 'mem', '--', 'node', SERVER_PATH], { stdio: 'pipe' });
    ok('MCP server registered: mem');
  } catch (e) {
    fail('MCP registration failed: ' + e.message);
    warn('Try manually: claude mcp add -s user -t stdio mem -- node ' + SERVER_PATH);
  }

  // 4. Configure hooks (merge: preserve user's existing hooks, replace ours)
  log('Configuring hooks...');
  const settings = readSettings();
  settings.hooks = settings.hooks || {};

  const PREFILTER_PATH = join(INSTALL_DIR, 'scripts', 'post-tool-use.sh');

  const memPostToolUse = {
    matcher: '*',
    hooks: [{
      type: 'command',
      command: `bash "${PREFILTER_PATH}"`,
      timeout: 5
    }]
  };

  const memSessionStart = {
    matcher: 'startup|clear|compact',
    hooks: [{
      type: 'command',
      command: `node "${HOOK_PATH}" session-start`,
      timeout: 10
    }]
  };

  const memStop = {
    matcher: '*',
    hooks: [{
      type: 'command',
      command: `node "${HOOK_PATH}" stop`,
      timeout: 5
    }]
  };

  const memPreToolUse = {
    matcher: '*',
    hooks: [{
      type: 'command',
      command: `node "${HOOK_PATH}" pre-tool-use`,
      timeout: 2
    }]
  };

  const memUserPrompt = {
    matcher: '*',
    hooks: [{
      type: 'command',
      command: `node "${HOOK_PATH}" user-prompt`,
      timeout: 5
    }]
  };

  // Filter out existing mem hooks, then append fresh ones
  for (const [event, config] of [['PostToolUse', memPostToolUse], ['PreToolUse', memPreToolUse], ['SessionStart', memSessionStart], ['Stop', memStop], ['UserPromptSubmit', memUserPrompt]]) {
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event].filter(cfg => !isMemHook(cfg)) : [];
    settings.hooks[event] = [...existing, config];
  }

  writeSettings(settings);
  ok('Hooks configured (PreToolUse, PostToolUse, SessionStart, Stop, UserPromptSubmit)');

  // 5. Migrate from old ~/.claude-mem/ if needed
  if (existsSync(join(OLD_DATA_DIR, 'claude-mem.db')) && !existsSync(DB_PATH) && !existsSync(join(DATA_DIR, 'claude-mem.db'))) {
    log('Detected old ~/.claude-mem/ directory, migrating to ~/.claude-mem-lite/...');
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      // Migrate database and WAL/SHM files (copy as claude-mem-lite.db)
      const srcDb = join(OLD_DATA_DIR, 'claude-mem.db');
      if (existsSync(srcDb)) copyFileSync(srcDb, DB_PATH);
      for (const ext of ['-wal', '-shm']) {
        const src = join(OLD_DATA_DIR, 'claude-mem.db' + ext);
        if (existsSync(src)) copyFileSync(src, DB_PATH + ext);
      }
      // Migrate runtime directory
      const oldRuntime = join(OLD_DATA_DIR, 'runtime');
      const newRuntime = join(DATA_DIR, 'runtime');
      if (existsSync(oldRuntime) && !existsSync(newRuntime)) {
        cpSync(oldRuntime, newRuntime, { recursive: true });
      }
      ok('Data migrated from ~/.claude-mem/ → ~/.claude-mem-lite/');
      log('Old ~/.claude-mem/ preserved (remove manually when ready)');
    } catch (e) {
      warn('Migration failed: ' + e.message);
      log('You can copy manually: cp ~/.claude-mem/claude-mem.db ~/.claude-mem-lite/claude-mem-lite.db');
    }
  }

  // 5b. Rename claude-mem.db → claude-mem-lite.db in same directory
  const oldDbInDir = join(DATA_DIR, 'claude-mem.db');
  if (existsSync(oldDbInDir) && !existsSync(DB_PATH)) {
    renameSync(oldDbInDir, DB_PATH);
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(oldDbInDir + ext)) try { renameSync(oldDbInDir + ext, DB_PATH + ext); } catch {}
    }
    ok('Database renamed: claude-mem.db → claude-mem-lite.db');
  }

  // 6. Install pre-installed resources (skills + agents)
  log('Setting up skill/agent registry...');
  try {
    const manifestPath = join(INSTALL_DIR, 'registry', 'preinstalled.json');
    if (!existsSync(manifestPath)) {
      // For git-clone mode, check PROJECT_DIR
      const altPath = join(PROJECT_DIR, 'registry', 'preinstalled.json');
      if (existsSync(altPath)) {
        const registryDir = join(INSTALL_DIR, 'registry');
        if (!existsSync(registryDir)) mkdirSync(registryDir, { recursive: true });
        copyFileSync(altPath, manifestPath);
      }
    }

    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const resources = manifest.resources || [];

      if (resources.length > 0) {
        const managedDir = join(DATA_DIR, 'managed');

        // 6a. Git shallow clone unique repos
        const repos = new Map();
        for (const r of resources) {
          if (!repos.has(r.repo)) repos.set(r.repo, []);
          repos.get(r.repo).push(r);
        }

        let cloned = 0;
        for (const [repoUrl, entries] of repos) {
          const repoName = repoUrl.split('/').slice(-2).join('-');
          const clonePath = join(managedDir, 'repos', repoName);
          if (!existsSync(clonePath)) {
            try {
              mkdirSync(join(managedDir, 'repos'), { recursive: true });
              execFileSync('git', ['clone', '--depth', '1', `${repoUrl.replace(/\.git$/, '')}.git`, clonePath], { stdio: 'pipe', timeout: 30000 });
              cloned++;
            } catch {
              warn(`  Clone failed: ${repoUrl}`);
              continue;
            }
          }

          // Copy resources to managed/skills/ or managed/agents/
          for (const entry of entries) {
            const srcPath = entry.path === '.' ? clonePath : join(clonePath, entry.path);
            const destDir = join(managedDir, entry.type === 'skill' ? 'skills' : 'agents');
            const destPath = join(destDir, entry.name);
            if (!existsSync(destPath) && existsSync(srcPath)) {
              mkdirSync(destDir, { recursive: true });
              try {
                cpSync(srcPath, destPath, { recursive: true });
              } catch {}
            }
          }
        }
        ok(`Repos cloned (${cloned} new / ${repos.size} total)`);

        // 6b. Init registry DB and record preinstalled entries
        const { ensureRegistryDb } = await import('./registry.mjs');
        const regDbPath = join(DATA_DIR, 'resource-registry.db');
        const rdb = ensureRegistryDb(regDbPath);

        const insertPre = rdb.prepare(`
          INSERT OR REPLACE INTO preinstalled (name, type, repo_url, repo_path, tags, enabled)
          VALUES (?, ?, ?, ?, ?, 1)
        `);
        for (const r of resources) {
          insertPre.run(r.name, r.type, r.repo, r.path, JSON.stringify(r.tags || []));
        }
        ok(`Registry DB initialized (${resources.length} preinstalled entries)`);

        // 6c. Fetch GitHub stars (best-effort, unauthenticated)
        log('  Fetching GitHub stars...');
        const starCache = new Map();
        for (const [repoUrl] of repos) {
          const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
          if (match) {
            try {
              const apiUrl = `https://api.github.com/repos/${match[1]}/${match[2]}`;
              const res = execFileSync('curl', ['-sf', apiUrl], { encoding: 'utf8', timeout: 10000 });
              const data = JSON.parse(res);
              if (typeof data.stargazers_count === 'number') {
                starCache.set(repoUrl, data.stargazers_count);
              }
            } catch {}
          }
        }
        if (starCache.size > 0) ok(`Stars fetched (${starCache.size}/${repos.size} repos)`);

        // 6d. Scan and index resources (fallback-only, Haiku indexing deferred to first run)
        log('  Scanning resources...');
        const { scanAllResources, diffResources } = await import('./registry-scanner.mjs');
        const scanned = scanAllResources({ dataDir: DATA_DIR });

        // Attach star counts and repo URLs
        for (const s of scanned) {
          const entry = resources.find(r => r.name === s.name && r.type === s.type);
          if (entry) {
            s.repoUrl = entry.repo;
            s.repoStars = starCache.get(entry.repo) || 0;
          }
        }

        const { toIndex } = diffResources(rdb, scanned);
        if (toIndex.length > 0) {
          // Use fallback indexing at install time (no Haiku calls)
          // Full Haiku indexing happens on first SessionStart
          const { upsertResource } = await import('./registry.mjs');
          for (const res of toIndex) {
            try {
              const metaKey = `${res.type}:${res.name}`;
              const meta = RESOURCE_METADATA[metaKey];
              upsertResource(rdb, {
                name: res.name,
                type: res.type,
                status: 'active',
                source: res.source,
                repo_url: res.repoUrl || null,
                repo_stars: res.repoStars || 0,
                local_path: res.localPath,
                file_hash: res.fileHash,
                intent_tags: meta?.intent_tags || res.name.replace(/-/g, ' '),
                domain_tags: meta?.domain_tags || '',
                trigger_patterns: meta?.trigger_patterns || `when user needs ${res.name.replace(/-/g, ' ')}`,
                capability_summary: meta?.capability_summary || `${res.type}: ${res.name.replace(/-/g, ' ')}`,
              });
            } catch {}
          }
          ok(`Resources registered: ${toIndex.length} indexed`);
        }

        // Apply curated metadata to all known resources (fixes existing installs)
        reindexKnownResources(rdb);
        ok('Resource metadata curated (FTS5 reindexed)');

        rdb.close();
      }
    } else {
      log('  No preinstalled manifest found, skipping');
    }
  } catch (e) {
    warn('Resource setup: ' + e.message);
    log('  Skills/agents will be indexed on first use');
  }

  // 7. Verify database
  if (existsSync(DB_PATH)) {
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(DB_PATH, { readonly: true });
      const count = db.prepare('SELECT COUNT(*) as c FROM observations').get();
      db.close();
      ok(`Database accessible: ${count.c} observations`);
    } catch (e) {
      warn('Database check failed: ' + e.message);
    }
  } else {
    log('No existing database — will be created on first use');
  }

  // 8. Disable old claude-mem plugin
  if (settings.enabledPlugins?.['claude-mem@thedotmack'] !== undefined) {
    settings.enabledPlugins['claude-mem@thedotmack'] = false;
    writeSettings(settings);
    ok('Old claude-mem plugin disabled');
  }

  // 9. Offer to clean old vector-db
  const vectorDbPath = join(OLD_DATA_DIR, 'vector-db');
  if (existsSync(vectorDbPath)) {
    try {
      const size = execFileSync('du', ['-sh', vectorDbPath], { encoding: 'utf8' }).trim().split('\t')[0];
      warn(`Old vector-db exists (${size}). Run: rm -rf ~/.claude-mem/vector-db/`);
    } catch {}
  }

  console.log('\n  Done! Restart Claude Code to activate.\n');
}

// ─── Uninstall ──────────────────────────────────────────────────────────────

async function uninstall() {
  console.log('\nclaude-mem-lite uninstaller\n');

  // 1. Remove MCP
  try {
    execFileSync('claude', ['mcp', 'remove', '-s', 'user', 'mem'], { stdio: 'pipe' });
    ok('MCP server removed');
  } catch {
    warn('MCP server not found or already removed');
  }

  // 2. Remove hooks (match both npx and git-clone install paths)
  const settings = readSettings();
  if (settings.hooks) {
    for (const [event, configs] of Object.entries(settings.hooks)) {
      if (!Array.isArray(configs)) continue;
      settings.hooks[event] = configs.filter(cfg => !isMemHook(cfg));
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeSettings(settings);
    ok('Hooks removed');
  }

  // 3. Purge data if requested
  if (flags.has('--purge')) {
    const expectedPurgePath = join(homedir(), '.claude-mem-lite');
    if (existsSync(DATA_DIR) && DATA_DIR === expectedPurgePath) {
      rmSync(DATA_DIR, { recursive: true, force: true });
      ok('Data purged (~/.claude-mem-lite/)');
    } else if (existsSync(DATA_DIR)) {
      fail('DATA_DIR path mismatch, refusing to purge for safety: ' + DATA_DIR);
    }
  } else {
    log('Data preserved in ~/.claude-mem-lite/ (use --purge to remove)');
  }

  console.log('\n  Done!\n');
}

// ─── Status ─────────────────────────────────────────────────────────────────

async function status() {
  console.log('\nclaude-mem-lite status\n');

  // MCP
  try {
    const list = execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8' });
    if (list.includes('mem:') || list.includes('mem ')) {
      ok('MCP server: registered');
    } else {
      fail('MCP server: not registered');
    }
  } catch {
    warn('Could not check MCP status');
  }

  // Hooks
  const settings = readSettings();
  const hasHooks = settings.hooks && Object.values(settings.hooks).some(configs =>
    configs.some(cfg => cfg.hooks?.some(h => h.command?.includes('hook.mjs')))
  );
  if (hasHooks) {
    ok('Hooks: configured');
  } else {
    fail('Hooks: not configured');
  }

  // Database
  if (existsSync(DB_PATH)) {
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(DB_PATH, { readonly: true });
      const obs = db.prepare('SELECT COUNT(*) as c FROM observations').get();
      const sess = db.prepare('SELECT COUNT(*) as c FROM session_summaries').get();
      db.close();
      ok(`Database: ${obs.c} observations, ${sess.c} sessions`);
    } catch (e) {
      warn('Database: exists but check failed — ' + e.message);
    }
  } else {
    warn('Database: not found');
  }

  // Old system
  const vectorDb = join(OLD_DATA_DIR, 'vector-db');
  if (existsSync(vectorDb)) {
    warn('Old vector-db still exists (can be removed)');
  }

  console.log('');
}

// ─── Doctor ─────────────────────────────────────────────────────────────────

async function doctor() {
  console.log('\nclaude-mem-lite doctor\n');
  let issues = 0;

  // Node version
  const nodeVer = process.version;
  if (parseInt(nodeVer.slice(1)) >= 18) {
    ok(`Node.js: ${nodeVer}`);
  } else {
    fail(`Node.js ${nodeVer} too old (need >=18)`);
    issues++;
  }

  // Dependencies
  const bsPath = join(INSTALL_DIR, 'node_modules', 'better-sqlite3');
  if (existsSync(bsPath)) {
    ok('better-sqlite3: installed');
  } else {
    fail('better-sqlite3: not installed (run install again)');
    issues++;
  }

  const mcpPath = join(INSTALL_DIR, 'node_modules', '@modelcontextprotocol');
  if (existsSync(mcpPath)) {
    ok('@modelcontextprotocol/sdk: installed');
  } else {
    fail('@modelcontextprotocol/sdk: not installed');
    issues++;
  }

  // Server file
  if (existsSync(SERVER_PATH)) {
    ok(`server.mjs: ${SERVER_PATH}`);
  } else {
    fail('server.mjs: missing');
    issues++;
  }

  // Hook file
  if (existsSync(HOOK_PATH)) {
    ok(`hook.mjs: ${HOOK_PATH}`);
  } else {
    fail('hook.mjs: missing');
    issues++;
  }

  // Database
  if (existsSync(DB_PATH)) {
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(DB_PATH, { readonly: true });
      // Check FTS
      const fts = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='observations_fts'").get();
      db.close();
      if (fts) {
        ok('FTS5 index: present');
      } else {
        warn('FTS5 index: missing (will be created on server start)');
      }
    } catch (e) {
      fail('Database: ' + e.message);
      issues++;
    }
  } else {
    warn('Database: not found (will be created)');
  }

  // Check for stale processes
  try {
    const procs = execSync('pgrep -af "chroma|claude-mem.*worker" 2>/dev/null', { encoding: 'utf8' }).trim();
    // Filter out the pgrep process itself (matches its own pattern)
    const real = procs.split('\n').filter(l => !l.includes('pgrep'));
    if (real.length > 0) {
      warn('Old processes running:\n    ' + real.join('\n    '));
      issues++;
    }
  } catch {
    ok('No stale processes');
  }

  console.log(`\n  ${issues === 0 ? 'All checks passed!' : `${issues} issue(s) found.`}\n`);
}

// ─── Settings helpers ───────────────────────────────────────────────────────

function isMemHook(cfg) {
  if (!cfg.hooks) return false;
  return cfg.hooks.some(h => {
    const cmd = h.command || '';
    return cmd.includes('claude-mem-lite') ||
      (cmd.includes('hook.mjs') && /\b(session-start|stop|user-prompt|pre-tool-use)\b/.test(cmd)) ||
      cmd.includes('scripts/post-tool-use.sh');
  });
}

function readSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  const settingsDir = dirname(SETTINGS_PATH);
  if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
  const tmp = SETTINGS_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, SETTINGS_PATH);
}

// ─── Main ───────────────────────────────────────────────────────────────────

switch (cmd) {
  case 'install':
    await install();
    break;
  case 'uninstall':
    await uninstall();
    break;
  case 'status':
    await status();
    break;
  case 'doctor':
    await doctor();
    break;
  default:
    if (IS_NPX) {
      // npx claude-mem-lite (no args) → auto install
      await install();
    } else {
      console.log(`
claude-mem-lite — Lightweight memory system for Claude Code

Usage:
  node install.mjs install            Install (copy files to ~/.claude-mem-lite/)
  node install.mjs install --dev      Install dev mode (symlinks to dev dir)
  node install.mjs uninstall          Remove (keep data)
  node install.mjs uninstall --purge  Remove and delete all data
  node install.mjs status             Show current status
  node install.mjs doctor             Diagnose issues

  npx claude-mem-lite                 Install via npx (one-liner)
`);
    }
}
