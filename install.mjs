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
    invocation_name: 'frontend-design:frontend-design',
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
    invocation_name: 'superpowers:brainstorming',
  },
  'skill:superpowers-tdd': {
    intent_tags: 'test,tdd,testing,unittest,spec,coverage,quality,red-green-refactor',
    domain_tags: 'testing,javascript,typescript,python',
    capability_summary: 'Test-driven development workflow with red-green-refactor cycle and quality checks',
    trigger_patterns: 'when user wants to write tests first or follow TDD methodology for feature development',
    invocation_name: 'superpowers:test-driven-development',
  },
  'skill:superpowers-debugging': {
    intent_tags: 'debug,troubleshoot,fix,error,systematic,diagnose,bug,crash,failure',
    domain_tags: 'debugging,error-handling',
    capability_summary: 'Systematic debugging approach for complex bugs using hypothesis-driven investigation',
    trigger_patterns: 'when user encounters bugs errors crashes or unexpected behavior that needs systematic debugging',
    invocation_name: 'superpowers:systematic-debugging',
  },
  'skill:superpowers-code-review': {
    intent_tags: 'review,code-review,quality,audit,feedback,inspect,pr-review',
    domain_tags: 'quality,review',
    capability_summary: 'Structured code review requesting with quality checklists and feedback gathering',
    trigger_patterns: 'when user wants to request or perform a thorough code review of their changes',
    invocation_name: 'superpowers:requesting-code-review',
  },
  'skill:superpowers-writing-plans': {
    intent_tags: 'plan,architecture,spec,implementation,blueprint,roadmap,strategy',
    domain_tags: 'planning,architecture',
    capability_summary: 'Write structured implementation plans from specs before touching code',
    trigger_patterns: 'when user has requirements or specs and needs a multi-step implementation plan before coding',
    invocation_name: 'superpowers:writing-plans',
  },
  'skill:superpowers-git-worktrees': {
    intent_tags: 'git,worktree,branch,isolation,parallel,workspace',
    domain_tags: 'git,workflow',
    capability_summary: 'Create isolated git worktrees for parallel feature development',
    trigger_patterns: 'when user needs to work on multiple branches simultaneously or isolate feature work',
    invocation_name: 'superpowers:using-git-worktrees',
  },
  'skill:superpowers-verification': {
    intent_tags: 'verify,check,test,complete,quality,validation,evidence',
    domain_tags: 'quality,verification',
    capability_summary: 'Verify work is complete by running checks and gathering evidence before claiming done',
    trigger_patterns: 'when user is about to claim work is complete and needs verification before committing',
    invocation_name: 'superpowers:verification-before-completion',
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
  },  'skill:ab-test-setup': {
    intent_tags: 'ab-test,experiment,cro,conversion,split-test,variant,marketing',
    domain_tags: 'marketing,cro,analytics',
    capability_summary: 'Set up A/B tests with variant design hypothesis tracking and statistical analysis',
    trigger_patterns: 'when user needs to set up A/B tests or split tests for marketing experiments',
  },
  'skill:ad-creative': {
    intent_tags: 'ad,creative,advertising,copy,banner,campaign,visual,marketing',
    domain_tags: 'marketing,advertising,creative',
    capability_summary: 'Create compelling ad creative copy and visuals for advertising campaigns',
    trigger_patterns: 'when user needs to create ad creatives copy or advertising campaign assets',
  },
  'skill:ai-seo': {
    intent_tags: 'ai,seo,search,optimization,llm,generative,marketing',
    domain_tags: 'marketing,seo,ai',
    capability_summary: 'AI-powered SEO optimization for search visibility and content ranking',
    trigger_patterns: 'when user needs AI-driven SEO strategies or search optimization',
  },
  'skill:analytics-tracking': {
    intent_tags: 'analytics,tracking,metrics,data,ga4,events,conversion,marketing',
    domain_tags: 'marketing,analytics,data',
    capability_summary: 'Set up analytics tracking events conversion goals and marketing metrics',
    trigger_patterns: 'when user needs to set up analytics tracking events or marketing metrics',
  },
  'skill:churn-prevention': {
    intent_tags: 'churn,retention,customer,saas,lifecycle,engagement,marketing',
    domain_tags: 'marketing,retention,saas',
    capability_summary: 'Design churn prevention strategies with retention campaigns and lifecycle engagement',
    trigger_patterns: 'when user needs to reduce churn or improve customer retention',
  },
  'skill:cold-email': {
    intent_tags: 'cold-email,outreach,sales,prospecting,email,b2b,marketing',
    domain_tags: 'marketing,email,sales',
    capability_summary: 'Write effective cold email sequences for outreach and sales prospecting',
    trigger_patterns: 'when user needs to write cold emails outreach sequences or sales prospecting messages',
  },
  'skill:competitor-alternatives': {
    intent_tags: 'competitor,alternatives,comparison,analysis,positioning,marketing',
    domain_tags: 'marketing,seo,competitive',
    capability_summary: 'Create competitor comparison and alternatives pages for SEO and positioning',
    trigger_patterns: 'when user needs competitor analysis alternative comparison pages or competitive positioning',
  },
  'skill:content-strategy': {
    intent_tags: 'content,strategy,blog,editorial,calendar,publishing,marketing',
    domain_tags: 'marketing,content,editorial',
    capability_summary: 'Plan content strategy with editorial calendars topic clusters and publishing workflows',
    trigger_patterns: 'when user needs content strategy editorial planning or blog content organization',
  },
  'skill:copy-editing': {
    intent_tags: 'copy-editing,proofread,writing,grammar,clarity,tone,marketing',
    domain_tags: 'marketing,writing,editing',
    capability_summary: 'Professional copy editing for marketing content with clarity tone and grammar improvement',
    trigger_patterns: 'when user needs copy editing proofreading or marketing content polishing',
  },
  'skill:copywriting': {
    intent_tags: 'copywriting,persuasion,landing-page,headline,cta,conversion,marketing',
    domain_tags: 'marketing,copywriting,conversion',
    capability_summary: 'Write persuasive marketing copy for landing pages headlines CTAs and conversion',
    trigger_patterns: 'when user needs persuasive copywriting for landing pages or marketing materials',
  },
  'skill:email-sequence': {
    intent_tags: 'email,sequence,drip,automation,nurture,onboarding,marketing',
    domain_tags: 'marketing,email,automation',
    capability_summary: 'Design email sequences with drip campaigns nurture flows and automated triggers',
    trigger_patterns: 'when user needs to create email sequences drip campaigns or automated email flows',
  },
  'skill:form-cro': {
    intent_tags: 'form,cro,conversion,optimization,signup,lead,marketing',
    domain_tags: 'marketing,cro,forms',
    capability_summary: 'Optimize web forms for higher conversion rates with field reduction and UX improvements',
    trigger_patterns: 'when user needs to optimize forms for better conversion rates',
  },
  'skill:free-tool-strategy': {
    intent_tags: 'free-tool,growth,acquisition,lead-gen,viral,product-led,marketing',
    domain_tags: 'marketing,growth,product',
    capability_summary: 'Plan free tool strategies for lead generation viral growth and user acquisition',
    trigger_patterns: 'when user wants to build free tools for marketing lead generation or growth',
  },
  'skill:launch-strategy': {
    intent_tags: 'launch,strategy,go-to-market,product-launch,gtm,marketing',
    domain_tags: 'marketing,launch,product',
    capability_summary: 'Plan product launch strategies with go-to-market timelines and channel selection',
    trigger_patterns: 'when user needs a product launch strategy or go-to-market plan',
  },
  'skill:marketing-ideas': {
    intent_tags: 'marketing,ideas,brainstorm,growth,creative,campaign,marketing',
    domain_tags: 'marketing,creative,growth',
    capability_summary: 'Generate creative marketing ideas and growth campaign brainstorming',
    trigger_patterns: 'when user needs marketing ideas creative campaign concepts or growth brainstorming',
  },
  'skill:marketing-psychology': {
    intent_tags: 'psychology,persuasion,behavior,neuromarketing,bias,influence,marketing',
    domain_tags: 'marketing,psychology,persuasion',
    capability_summary: 'Apply marketing psychology principles like scarcity social proof and cognitive biases',
    trigger_patterns: 'when user wants to apply psychological principles to marketing or conversion optimization',
  },
  'skill:onboarding-cro': {
    intent_tags: 'onboarding,cro,activation,ux,first-run,welcome,marketing',
    domain_tags: 'marketing,cro,onboarding',
    capability_summary: 'Optimize user onboarding flows for activation and first-run conversion',
    trigger_patterns: 'when user needs to improve onboarding flows user activation or first-run experience',
  },
  'skill:page-cro': {
    intent_tags: 'page,cro,landing-page,conversion,layout,optimization,marketing',
    domain_tags: 'marketing,cro,landing-page',
    capability_summary: 'Optimize landing pages for conversion with layout copy and CTA improvements',
    trigger_patterns: 'when user needs to optimize landing pages or web pages for higher conversion',
  },
  'skill:paid-ads': {
    intent_tags: 'paid-ads,ppc,campaign,google-ads,meta-ads,budget,marketing',
    domain_tags: 'marketing,advertising,ppc',
    capability_summary: 'Plan and optimize paid advertising campaigns across Google Meta and ad platforms',
    trigger_patterns: 'when user needs to plan or optimize paid ad campaigns PPC or advertising budgets',
  },
  'skill:paywall-upgrade-cro': {
    intent_tags: 'paywall,upgrade,conversion,pricing,upsell,premium,marketing',
    domain_tags: 'marketing,cro,pricing',
    capability_summary: 'Optimize paywall and upgrade flows for premium conversion and upsell',
    trigger_patterns: 'when user needs to optimize paywall upgrade flows or premium conversion rates',
  },
  'skill:popup-cro': {
    intent_tags: 'popup,cro,conversion,lead-capture,exit-intent,modal,marketing',
    domain_tags: 'marketing,cro,popup',
    capability_summary: 'Design high-converting popups with exit-intent triggers and lead capture optimization',
    trigger_patterns: 'when user needs to create or optimize popups for lead capture or conversion',
  },
  'skill:pricing-strategy': {
    intent_tags: 'pricing,strategy,monetization,revenue,tiers,freemium,marketing',
    domain_tags: 'marketing,pricing,business',
    capability_summary: 'Design pricing strategies with tier structures freemium models and revenue optimization',
    trigger_patterns: 'when user needs pricing strategy tier design or monetization planning',
  },
  'skill:product-marketing-context': {
    intent_tags: 'product,positioning,messaging,value-prop,context,differentiation,marketing',
    domain_tags: 'marketing,product,positioning',
    capability_summary: 'Define product positioning messaging and value proposition for marketing context',
    trigger_patterns: 'when user needs product positioning value proposition or marketing messaging framework',
  },
  'skill:programmatic-seo': {
    intent_tags: 'programmatic-seo,automation,pages,templates,scale,marketing',
    domain_tags: 'marketing,seo,automation',
    capability_summary: 'Build programmatic SEO pages at scale with templates and automated content generation',
    trigger_patterns: 'when user needs programmatic SEO pages at scale or templated content generation',
  },
  'skill:referral-program': {
    intent_tags: 'referral,viral,growth,program,incentive,share,marketing',
    domain_tags: 'marketing,growth,referral',
    capability_summary: 'Design referral programs with incentive structures viral mechanics and tracking',
    trigger_patterns: 'when user needs to design referral programs or viral growth mechanics',
  },
  'skill:schema-markup': {
    intent_tags: 'schema,structured-data,seo,markup,rich-snippets,json-ld,marketing',
    domain_tags: 'marketing,seo,schema',
    capability_summary: 'Implement schema markup and structured data for rich search snippets',
    trigger_patterns: 'when user needs schema markup structured data or JSON-LD for SEO',
  },
  'skill:mktg-seo-audit': {
    intent_tags: 'seo,audit,technical,analysis,crawl,marketing',
    domain_tags: 'marketing,seo,audit',
    capability_summary: 'Marketing-focused SEO audit with technical and content analysis',
    trigger_patterns: 'when user needs a marketing-focused SEO audit or technical site analysis',
  },
  'skill:signup-flow-cro': {
    intent_tags: 'signup,flow,cro,conversion,registration,onboarding,marketing',
    domain_tags: 'marketing,cro,signup',
    capability_summary: 'Optimize signup and registration flows for higher conversion rates',
    trigger_patterns: 'when user needs to optimize signup flows registration pages or conversion funnels',
  },
  'skill:social-content': {
    intent_tags: 'social,content,twitter,linkedin,posts,engagement,marketing',
    domain_tags: 'marketing,social-media,content',
    capability_summary: 'Create engaging social media content for Twitter LinkedIn and social platforms',
    trigger_patterns: 'when user needs social media content posts or engagement strategies',
  },
  'skill:seo-audit': {
    intent_tags: 'seo,audit,technical,analysis,crawl,indexing',
    domain_tags: 'seo,audit,web',
    capability_summary: 'Comprehensive SEO audit with technical analysis crawl errors and performance checks',
    trigger_patterns: 'when user needs a comprehensive SEO audit or technical site analysis',
  },
  'skill:seo-competitor-pages': {
    intent_tags: 'seo,competitor,pages,analysis,serp,ranking,gap',
    domain_tags: 'seo,competitive,analysis',
    capability_summary: 'Analyze competitor pages for SEO strategy gaps and ranking opportunities',
    trigger_patterns: 'when user needs SEO competitor page analysis or SERP gap identification',
  },
  'skill:seo-content': {
    intent_tags: 'seo,content,optimization,keywords,writing,on-page,headings',
    domain_tags: 'seo,content,writing',
    capability_summary: 'Optimize content for SEO with keyword integration heading structure and readability',
    trigger_patterns: 'when user needs to optimize content for SEO keywords or on-page factors',
  },
  'skill:seo-geo': {
    intent_tags: 'seo,geo,local,location,regional,gmb,maps',
    domain_tags: 'seo,local,geo',
    capability_summary: 'Implement geo-targeted and local SEO strategies for regional visibility',
    trigger_patterns: 'when user needs local SEO geo-targeting or regional search optimization',
  },
  'skill:seo-hreflang': {
    intent_tags: 'seo,hreflang,international,multilingual,i18n,language,region',
    domain_tags: 'seo,international,i18n',
    capability_summary: 'Implement hreflang tags for international and multilingual SEO',
    trigger_patterns: 'when user needs hreflang implementation international SEO or multilingual site setup',
  },
  'skill:seo-images': {
    intent_tags: 'seo,images,optimization,alt-text,compression,webp,lazy-load',
    domain_tags: 'seo,images,performance',
    capability_summary: 'Optimize images for SEO with alt text compression formats and lazy loading',
    trigger_patterns: 'when user needs image SEO optimization alt text or image compression strategies',
  },
  'skill:seo-page': {
    intent_tags: 'seo,page,on-page,meta,title,description,optimization',
    domain_tags: 'seo,on-page,meta',
    capability_summary: 'On-page SEO optimization with meta tags title optimization and page structure',
    trigger_patterns: 'when user needs on-page SEO meta tag optimization or page structure improvements',
  },
  'skill:seo-plan': {
    intent_tags: 'seo,plan,strategy,roadmap,goals,timeline,priorities',
    domain_tags: 'seo,strategy,planning',
    capability_summary: 'Create SEO strategy plans with goals roadmap timelines and priority actions',
    trigger_patterns: 'when user needs an SEO strategy plan roadmap or prioritized action items',
  },
  'skill:seo-programmatic': {
    intent_tags: 'seo,programmatic,scale,templates,automation,dynamic,pages',
    domain_tags: 'seo,programmatic,automation',
    capability_summary: 'Build programmatic SEO with dynamic templates and automated page generation at scale',
    trigger_patterns: 'when user needs programmatic SEO dynamic page generation or automated content at scale',
  },
  'skill:seo-schema': {
    intent_tags: 'seo,schema,structured-data,json-ld,rich-snippets,markup',
    domain_tags: 'seo,schema,structured-data',
    capability_summary: 'Implement SEO schema markup with JSON-LD for rich snippets and search features',
    trigger_patterns: 'when user needs SEO schema markup JSON-LD or structured data implementation',
  },
  'skill:seo-sitemap': {
    intent_tags: 'seo,sitemap,xml,crawl,index,robots,submission',
    domain_tags: 'seo,sitemap,technical',
    capability_summary: 'Generate and optimize XML sitemaps for crawl efficiency and index coverage',
    trigger_patterns: 'when user needs XML sitemap generation optimization or crawl management',
  },
  'skill:seo-technical': {
    intent_tags: 'seo,technical,core-web-vitals,crawl,indexing',
    domain_tags: 'seo,technical',
    capability_summary: 'Technical SEO audit covering core web vitals site speed crawlability and indexing',
    trigger_patterns: 'when user needs technical SEO improvements core web vitals or site speed optimization',
  },
  'agent:seo-content-agent': {
    intent_tags: 'seo,content,agent,writing,optimization,automated',
    domain_tags: 'seo,content,agent',
    capability_summary: 'Automated SEO content agent for writing and optimizing search-friendly content',
    trigger_patterns: 'when user wants automated SEO content writing or optimization assistance',
  },
  'agent:seo-performance-agent': {
    intent_tags: 'seo,agent,core-web-vitals,pagespeed',
    domain_tags: 'seo,agent',
    capability_summary: 'SEO performance monitoring agent for core web vitals and page speed analysis',
    trigger_patterns: 'when user needs automated SEO performance monitoring or speed optimization',
  },
  'agent:seo-schema-agent': {
    intent_tags: 'seo,schema,agent,structured-data,automation,json-ld',
    domain_tags: 'seo,schema,agent',
    capability_summary: 'Automated schema markup agent for generating and validating structured data',
    trigger_patterns: 'when user wants automated schema markup generation or structured data validation',
  },
  'agent:seo-sitemap-agent': {
    intent_tags: 'seo,sitemap,agent,xml,automation,crawl',
    domain_tags: 'seo,sitemap,agent',
    capability_summary: 'Automated sitemap management agent for XML generation and submission',
    trigger_patterns: 'when user wants automated sitemap generation management or submission',
  },
  'agent:seo-technical-agent': {
    intent_tags: 'seo,technical,agent,audit,automation,crawl,indexing',
    domain_tags: 'seo,technical,agent',
    capability_summary: 'Automated technical SEO agent for crawl analysis indexing and site health monitoring',
    trigger_patterns: 'when user wants automated technical SEO audits or site health monitoring',
  },
  'agent:seo-visual-agent': {
    intent_tags: 'seo,visual,agent,images,design,alt-text,optimization',
    domain_tags: 'seo,visual,agent',
    capability_summary: 'SEO visual optimization agent for image alt text and visual content analysis',
    trigger_patterns: 'when user wants automated image SEO optimization or visual content analysis',
  },
  'skill:humanizer': {
    intent_tags: 'humanize,writing,ai-detection,tone,natural,rewrite,polish',
    domain_tags: 'writing,editing,content',
    capability_summary: 'Remove signs of AI-generated writing to make text sound natural and human',
    trigger_patterns: 'when user wants to humanize AI-generated text or remove AI writing patterns',
  },
  'skill:claudeception': {
    intent_tags: 'skill-extraction,learning,continuous,autonomous,meta,knowledge',
    domain_tags: 'meta,learning,skills',
    capability_summary: 'Autonomous skill extraction and continuous learning from Claude Code work sessions',
    trigger_patterns: 'when user wants to extract reusable skills from work sessions or enable continuous learning',
  },
  'skill:anthropic-architect': {
    intent_tags: 'anthropic,architecture,system-design,claude,patterns,best-practices',
    domain_tags: 'anthropic,architecture,ai',
    capability_summary: 'Architect Anthropic Claude-based systems with best practice patterns and design',
    trigger_patterns: 'when user needs to architect systems using Anthropic Claude APIs or AI patterns',
  },
  'skill:anthropic-prompt-engineer': {
    intent_tags: 'anthropic,prompt,engineering,claude,optimization,techniques',
    domain_tags: 'anthropic,prompt,ai',
    capability_summary: 'Expert Anthropic prompt engineering with optimization techniques for Claude',
    trigger_patterns: 'when user needs prompt engineering for Anthropic Claude models',
  },
  'skill:apple-hig-designer': {
    intent_tags: 'apple,hig,design,ios,macos,ui,human-interface,guidelines',
    domain_tags: 'apple,design,ios,macos',
    capability_summary: 'Design Apple HIG-compliant interfaces for iOS macOS and Apple platforms',
    trigger_patterns: 'when user needs Apple Human Interface Guidelines compliant UI design',
  },
  'skill:book-illustrator': {
    intent_tags: 'illustration,book,art,visual,creative,drawing,children',
    domain_tags: 'illustration,art,creative',
    capability_summary: 'Create book illustrations with visual storytelling and artistic direction',
    trigger_patterns: 'when user needs book illustrations visual art or creative illustration direction',
  },
  'skill:content-brief-generator': {
    intent_tags: 'content,brief,generator,writing,planning,outline,structure',
    domain_tags: 'content,writing,planning',
    capability_summary: 'Generate structured content briefs with outlines target audience and key messages',
    trigger_patterns: 'when user needs content briefs writing outlines or structured content plans',
  },
  'skill:design-brief-generator': {
    intent_tags: 'design,brief,generator,creative,project,requirements,visual',
    domain_tags: 'design,creative,project',
    capability_summary: 'Generate design briefs with creative requirements visual direction and project scope',
    trigger_patterns: 'when user needs design briefs creative direction or project visual requirements',
  },
  'skill:engineer-expertise-extractor': {
    intent_tags: 'expertise,extraction,knowledge,engineering,skills,assessment',
    domain_tags: 'engineering,knowledge,assessment',
    capability_summary: 'Extract and document engineering expertise knowledge and skill assessments',
    trigger_patterns: 'when user needs to extract document or assess engineering expertise and knowledge',
  },
  'skill:engineer-skill-creator': {
    intent_tags: 'skill,creator,engineering,development,custom,workflow',
    domain_tags: 'engineering,skills,meta',
    capability_summary: 'Create engineering-focused custom skills and development workflows',
    trigger_patterns: 'when user wants to create engineering-focused custom skills or workflows',
  },
  'skill:frontend-designer': {
    intent_tags: 'frontend,designer,ui,web,visual,layout,responsive',
    domain_tags: 'frontend,design,web',
    capability_summary: 'Frontend design with visual UI layout responsive design and web aesthetics',
    trigger_patterns: 'when user needs frontend visual design responsive layouts or web UI aesthetics',
  },
  'skill:git-worktrees': {
    intent_tags: 'git,worktree,branch,parallel,workflow,isolation',
    domain_tags: 'git,workflow,development',
    capability_summary: 'Git worktree workflows for parallel branch development and isolation',
    trigger_patterns: 'when user needs git worktree setup for parallel development or branch isolation',
  },
  'skill:kids-book-writer': {
    intent_tags: 'children,book,writing,story,creative,kids,illustration',
    domain_tags: 'writing,children,creative',
    capability_summary: 'Write children books with age-appropriate stories and illustration guidance',
    trigger_patterns: 'when user wants to write children books or create kids story content',
  },
  'skill:leetcode-teacher': {
    intent_tags: 'leetcode,algorithms,teaching,interview,coding,data-structures',
    domain_tags: 'algorithms,education,interview',
    capability_summary: 'Teach LeetCode problems with algorithm explanations and interview preparation',
    trigger_patterns: 'when user needs help with LeetCode problems algorithm learning or coding interviews',
  },
  'skill:llm-router': {
    intent_tags: 'llm,router,model,selection,orchestration,multi-model,dispatch',
    domain_tags: 'ai,llm,orchestration',
    capability_summary: 'Route LLM requests to optimal models based on task complexity and requirements',
    trigger_patterns: 'when user needs LLM routing multi-model selection or request orchestration',
  },
  'skill:math-teacher': {
    intent_tags: 'math,teaching,education,tutor,problems,algebra,calculus',
    domain_tags: 'math,education,tutoring',
    capability_summary: 'Teach mathematics with step-by-step explanations and practice problem guidance',
    trigger_patterns: 'when user needs math tutoring explanations or practice problem help',
  },
  'skill:openai-prompt-engineer': {
    intent_tags: 'openai,prompt,engineering,gpt,optimization,techniques',
    domain_tags: 'openai,prompt,ai',
    capability_summary: 'Expert OpenAI prompt engineering with GPT optimization techniques',
    trigger_patterns: 'when user needs prompt engineering for OpenAI GPT models',
  },
  'skill:prd-generator': {
    intent_tags: 'prd,product,requirements,document,spec,features,scope',
    domain_tags: 'product,requirements,planning',
    capability_summary: 'Generate product requirements documents with features scope and specifications',
    trigger_patterns: 'when user needs to create PRDs product requirements documents or feature specifications',
  },
  'skill:qa-test-planner': {
    intent_tags: 'qa,test,planner,quality,testing,strategy,coverage',
    domain_tags: 'qa,testing,planning',
    capability_summary: 'Plan QA test strategies with coverage mapping test cases and quality assurance',
    trigger_patterns: 'when user needs QA test planning test strategy or test coverage mapping',
  },
  'skill:query-expert': {
    intent_tags: 'query,sql,database,optimization,expert,performance,tuning',
    domain_tags: 'sql,database,query',
    capability_summary: 'Expert SQL query writing optimization and database performance tuning',
    trigger_patterns: 'when user needs expert SQL query writing or database query optimization',
  },
  'skill:reading-teacher': {
    intent_tags: 'reading,teaching,education,literacy,comprehension,phonics',
    domain_tags: 'education,reading,literacy',
    capability_summary: 'Teach reading skills with comprehension strategies and literacy development',
    trigger_patterns: 'when user needs reading instruction literacy development or comprehension strategies',
  },
  'skill:releasing-macos-apps': {
    intent_tags: 'macos,release,app-store,distribution,apple,notarize,signing',
    domain_tags: 'macos,release,apple',
    capability_summary: 'Guide macOS app release with App Store submission notarization and distribution',
    trigger_patterns: 'when user needs to release a macOS app to the App Store or handle code signing',
  },
  'skill:swift-concurrency': {
    intent_tags: 'swift,concurrency,async,await,actor,structured,task',
    domain_tags: 'swift,ios,concurrency',
    capability_summary: 'Swift concurrency with async/await actors structured concurrency and task groups',
    trigger_patterns: 'when user needs Swift concurrency patterns async/await or actor-based design',
  },
  'skill:swiftui-animation': {
    intent_tags: 'swiftui,animation,ios,motion,transition,effect,visual',
    domain_tags: 'swiftui,ios,animation',
    capability_summary: 'Create SwiftUI animations with transitions motion effects and visual polish',
    trigger_patterns: 'when user needs SwiftUI animations transitions or motion design for iOS apps',
  },
  'skill:technical-launch-planner': {
    intent_tags: 'launch,technical,planner,deployment,release,checklist,rollout',
    domain_tags: 'deployment,planning,release',
    capability_summary: 'Plan technical product launches with deployment checklists and rollout strategy',
    trigger_patterns: 'when user needs technical launch planning deployment checklists or release management',
  },
  'skill:trading-plan-generator': {
    intent_tags: 'trading,plan,finance,strategy,markets,risk,portfolio',
    domain_tags: 'finance,trading,markets',
    capability_summary: 'Generate trading plans with strategy risk management and portfolio analysis',
    trigger_patterns: 'when user needs trading plans investment strategies or portfolio analysis',
  },
  'agent:accessibility-compliance': {
    intent_tags: 'accessibility,a11y,compliance,wcag,aria,screen-reader,inclusive',
    domain_tags: 'accessibility,web,compliance',
    capability_summary: 'Accessibility compliance agent for WCAG auditing ARIA implementation and a11y testing',
    trigger_patterns: 'when user needs accessibility auditing WCAG compliance or ARIA implementation',
  },
  'agent:agent-orchestration': {
    intent_tags: 'agent,orchestration,multi-agent,workflow,coordination,pipeline',
    domain_tags: 'agents,orchestration,automation',
    capability_summary: 'Multi-agent orchestration with workflow coordination and pipeline management',
    trigger_patterns: 'when user needs multi-agent orchestration workflow coordination or agent pipelines',
  },
  'agent:agent-teams': {
    intent_tags: 'agent,teams,collaboration,multi-agent,roles,delegation',
    domain_tags: 'agents,teams,collaboration',
    capability_summary: 'Agent team management with role delegation and collaborative task execution',
    trigger_patterns: 'when user needs agent team collaboration role-based delegation or multi-agent teamwork',
  },
  'agent:api-testing-observability': {
    intent_tags: 'api,testing,observability,monitoring,tracing,health-check',
    domain_tags: 'api,testing,observability',
    capability_summary: 'API testing and observability with health checks tracing and monitoring dashboards',
    trigger_patterns: 'when user needs API testing observability setup or endpoint monitoring',
  },
  'agent:arm-cortex-microcontrollers': {
    intent_tags: 'arm,cortex,embedded,microcontroller,firmware,iot,rtos',
    domain_tags: 'embedded,arm,firmware',
    capability_summary: 'ARM Cortex microcontroller development with firmware RTOS and embedded programming',
    trigger_patterns: 'when user needs ARM Cortex microcontroller firmware or embedded systems development',
  },
  'agent:backend-api-security': {
    intent_tags: 'backend,api,security,auth,owasp,jwt,rate-limit',
    domain_tags: 'security,backend,api',
    capability_summary: 'Backend API security with authentication rate limiting and OWASP protection',
    trigger_patterns: 'when user needs API security authentication setup or backend security hardening',
  },
  'agent:backend-development': {
    intent_tags: 'backend,development,server,api,node,express,architecture',
    domain_tags: 'backend,server,api',
    capability_summary: 'Backend development agent for server-side API architecture and implementation',
    trigger_patterns: 'when user needs backend server development API architecture or server-side coding',
  },
  'agent:blockchain-web3': {
    intent_tags: 'blockchain,web3,smart-contract,solidity,ethereum,defi,nft',
    domain_tags: 'blockchain,web3,ethereum',
    capability_summary: 'Blockchain and Web3 development with smart contracts Solidity and DeFi patterns',
    trigger_patterns: 'when user needs blockchain development smart contracts Web3 or Solidity programming',
  },
  'agent:business-analytics': {
    intent_tags: 'business,analytics,data,dashboard,kpi,reporting,metrics',
    domain_tags: 'business,analytics,data',
    capability_summary: 'Business analytics with KPI dashboards reporting and data-driven insights',
    trigger_patterns: 'when user needs business analytics KPI dashboards or data reporting setup',
  },
  'agent:c4-architecture': {
    intent_tags: 'c4,architecture,diagram,system-design,modeling,context,container',
    domain_tags: 'architecture,c4,design',
    capability_summary: 'C4 architecture modeling with context container component and code diagrams',
    trigger_patterns: 'when user needs C4 architecture diagrams system modeling or design documentation',
  },
  'agent:codebase-cleanup': {
    intent_tags: 'cleanup,codebase,dead-code,lint,hygiene,unused,technical-debt',
    domain_tags: 'quality,cleanup,maintenance',
    capability_summary: 'Codebase cleanup agent for removing dead code fixing lint issues and reducing tech debt',
    trigger_patterns: 'when user needs codebase cleanup dead code removal or technical debt reduction',
  },
  'agent:comprehensive-review': {
    intent_tags: 'review,comprehensive,audit,quality,deep,thorough,analysis',
    domain_tags: 'quality,review,audit',
    capability_summary: 'Comprehensive code and project review with deep quality and architecture analysis',
    trigger_patterns: 'when user needs a thorough comprehensive code review or project quality audit',
  },
  'agent:conductor': {
    intent_tags: 'conductor,orchestrator,workflow,pipeline,automation,dispatch',
    domain_tags: 'orchestration,workflow,automation',
    capability_summary: 'Conductor agent for orchestrating complex multi-step workflows and pipelines',
    trigger_patterns: 'when user needs workflow orchestration pipeline management or task conductor setup',
  },
  'agent:content-marketing': {
    intent_tags: 'content,marketing,strategy,blog,seo,editorial,publishing',
    domain_tags: 'marketing,content,strategy',
    capability_summary: 'Content marketing agent for blog strategy editorial planning and SEO content',
    trigger_patterns: 'when user needs content marketing strategy blog planning or SEO-driven content',
  },
  'agent:context-management': {
    intent_tags: 'context,management,memory,state,session,persistence,window',
    domain_tags: 'context,memory,management',
    capability_summary: 'Context and memory management for maintaining state across agent sessions',
    trigger_patterns: 'when user needs context management memory persistence or session state handling',
  },
  'agent:customer-sales-automation': {
    intent_tags: 'customer,sales,automation,crm,pipeline,lead,outreach',
    domain_tags: 'sales,crm,automation',
    capability_summary: 'Customer sales automation with CRM pipeline management and lead nurturing',
    trigger_patterns: 'when user needs sales automation CRM pipeline setup or customer outreach workflows',
  },
  'agent:data-engineering': {
    intent_tags: 'data,engineering,pipeline,etl,warehouse,transform,ingest',
    domain_tags: 'data,engineering,pipeline',
    capability_summary: 'Data engineering with ETL pipelines data warehouse design and transformation',
    trigger_patterns: 'when user needs data engineering ETL pipelines or data warehouse architecture',
  },
  'agent:data-validation-suite': {
    intent_tags: 'data,validation,quality,schema,integrity,checks,rules',
    domain_tags: 'data,validation,quality',
    capability_summary: 'Data validation suite with schema checks integrity rules and quality assurance',
    trigger_patterns: 'when user needs data validation schema checks or data quality assurance',
  },
  'agent:database-cloud-optimization': {
    intent_tags: 'database,cloud,optimization,scaling,cost,performance,tuning',
    domain_tags: 'database,cloud,optimization',
    capability_summary: 'Cloud database optimization with scaling strategies cost reduction and performance tuning',
    trigger_patterns: 'when user needs cloud database optimization scaling or cost reduction strategies',
  },
  'agent:deployment-strategies': {
    intent_tags: 'deployment,strategies,blue-green,canary,rollout,zero-downtime',
    domain_tags: 'deployment,devops,strategies',
    capability_summary: 'Deployment strategy planning with blue-green canary and zero-downtime rollout patterns',
    trigger_patterns: 'when user needs deployment strategies blue-green canary or zero-downtime rollout planning',
  },
  'agent:deployment-validation': {
    intent_tags: 'deployment,validation,smoke-test,health,verify,post-deploy',
    domain_tags: 'deployment,validation,devops',
    capability_summary: 'Post-deployment validation with smoke tests health checks and verification',
    trigger_patterns: 'when user needs deployment validation smoke testing or post-deploy health checks',
  },
  'agent:developer-essentials': {
    intent_tags: 'developer,essentials,tools,productivity,workflow,setup,config',
    domain_tags: 'development,tools,productivity',
    capability_summary: 'Developer essentials toolkit for productivity tools workflow setup and configuration',
    trigger_patterns: 'when user needs developer productivity tools workflow optimization or environment setup',
  },
  'agent:distributed-debugging': {
    intent_tags: 'distributed,debugging,microservices,tracing,logs,correlation',
    domain_tags: 'debugging,distributed,microservices',
    capability_summary: 'Distributed system debugging with trace correlation log analysis and microservice diagnosis',
    trigger_patterns: 'when user needs distributed debugging microservice tracing or cross-service log analysis',
  },
  'agent:documentation-generation': {
    intent_tags: 'documentation,generation,auto-doc,api-docs,readme,javadoc',
    domain_tags: 'documentation,generation,automation',
    capability_summary: 'Automated documentation generation for APIs READMEs and code documentation',
    trigger_patterns: 'when user needs automated documentation generation API docs or README creation',
  },
  'agent:dotnet-contribution': {
    intent_tags: 'dotnet,csharp,contribution,aspnet,nuget,entity-framework',
    domain_tags: 'dotnet,csharp,aspnet',
    capability_summary: '.NET and C# development agent for ASP.NET Entity Framework and NuGet workflows',
    trigger_patterns: 'when user is working on .NET C# ASP.NET or Entity Framework projects',
  },
  'agent:error-diagnostics': {
    intent_tags: 'error,diagnostics,analysis,root-cause,triage,classification',
    domain_tags: 'debugging,diagnostics,error',
    capability_summary: 'Error diagnostics agent for root cause analysis triage and error classification',
    trigger_patterns: 'when user needs error diagnostics root cause analysis or automated error triage',
  },
  'agent:framework-migration': {
    intent_tags: 'framework,migration,upgrade,transition,compatibility,breaking-changes',
    domain_tags: 'migration,framework,upgrade',
    capability_summary: 'Framework migration agent for version upgrades breaking change resolution and transitions',
    trigger_patterns: 'when user needs to migrate frameworks upgrade versions or resolve breaking changes',
  },
  'agent:frontend-mobile-development': {
    intent_tags: 'frontend,mobile,react-native,flutter,responsive,cross-platform',
    domain_tags: 'frontend,mobile,cross-platform',
    capability_summary: 'Frontend and mobile development with React Native Flutter and cross-platform patterns',
    trigger_patterns: 'when user needs mobile app development React Native Flutter or cross-platform frontend',
  },
  'agent:frontend-mobile-security': {
    intent_tags: 'frontend,mobile,security,xss,csp,csrf,sanitization',
    domain_tags: 'security,frontend,mobile',
    capability_summary: 'Frontend and mobile security with XSS prevention CSP configuration and CSRF protection',
    trigger_patterns: 'when user needs frontend security XSS prevention or mobile app security hardening',
  },
  'agent:full-stack-orchestration': {
    intent_tags: 'fullstack,orchestration,frontend,backend,integration,end-to-end',
    domain_tags: 'fullstack,orchestration,integration',
    capability_summary: 'Full-stack orchestration agent for coordinating frontend backend and integration layers',
    trigger_patterns: 'when user needs full-stack orchestration end-to-end integration or frontend-backend coordination',
  },
  'agent:functional-programming': {
    intent_tags: 'functional,programming,fp,immutable,pure,monad,composition',
    domain_tags: 'functional,programming,patterns',
    capability_summary: 'Functional programming patterns with immutability composition and pure function design',
    trigger_patterns: 'when user needs functional programming patterns monads or immutable design help',
  },
  'agent:game-development': {
    intent_tags: 'game,development,unity,godot,gamedev,engine,mechanics',
    domain_tags: 'game,development,engine',
    capability_summary: 'Game development agent for Unity Godot game mechanics and interactive systems',
    trigger_patterns: 'when user needs game development help with Unity Godot or game mechanics design',
  },
  'agent:hr-legal-compliance': {
    intent_tags: 'hr,legal,compliance,policy,gdpr,privacy,regulation',
    domain_tags: 'legal,compliance,hr',
    capability_summary: 'HR and legal compliance agent for policy generation GDPR and regulatory requirements',
    trigger_patterns: 'when user needs HR legal compliance policy generation or GDPR regulatory guidance',
  },
  'agent:incident-response': {
    intent_tags: 'incident,response,sre,postmortem,alert,escalation,runbook',
    domain_tags: 'sre,incident,devops',
    capability_summary: 'Incident response agent with runbook execution escalation and postmortem analysis',
    trigger_patterns: 'when user needs incident response runbooks escalation workflows or postmortem analysis',
  },
  'agent:julia-development': {
    intent_tags: 'julia,scientific,computing,numerical,data,performance,math',
    domain_tags: 'julia,scientific,computing',
    capability_summary: 'Julia development agent for scientific computing numerical analysis and data processing',
    trigger_patterns: 'when user is working on Julia projects scientific computing or numerical programming',
  },
  'agent:jvm-languages': {
    intent_tags: 'jvm,java,kotlin,scala,gradle,maven,spring',
    domain_tags: 'jvm,java,kotlin',
    capability_summary: 'JVM language development agent for Java Kotlin Scala with Spring and Gradle',
    trigger_patterns: 'when user is working on JVM projects Java Kotlin Scala or Spring applications',
  },
  'agent:kubernetes-operations': {
    intent_tags: 'kubernetes,k8s,devops,container,helm,deploy,cluster',
    domain_tags: 'kubernetes,devops,container',
    capability_summary: 'Kubernetes operations agent for cluster management Helm deployments and container orchestration',
    trigger_patterns: 'when user needs Kubernetes cluster management Helm charts or container orchestration',
  },
  'agent:llm-application-dev': {
    intent_tags: 'llm,application,ai,rag,agent,prompt,chain',
    domain_tags: 'ai,llm,application',
    capability_summary: 'LLM application development with RAG agent design and prompt engineering',
    trigger_patterns: 'when user needs to build LLM applications RAG systems or AI agent architectures',
  },
  'agent:machine-learning-ops': {
    intent_tags: 'mlops,ml,training,deployment,pipeline,model,inference',
    domain_tags: 'ml,mlops,data-science',
    capability_summary: 'MLOps agent for model training deployment pipelines and ML infrastructure',
    trigger_patterns: 'when user needs MLOps model training pipelines or ML deployment infrastructure',
  },
  'agent:multi-platform-apps': {
    intent_tags: 'multi-platform,cross-platform,desktop,mobile,web,electron,tauri',
    domain_tags: 'cross-platform,desktop,mobile',
    capability_summary: 'Multi-platform app development with Electron Tauri and cross-platform frameworks',
    trigger_patterns: 'when user needs multi-platform app development Electron Tauri or cross-platform solutions',
  },
  'agent:observability-monitoring': {
    intent_tags: 'observability,monitoring,logging,metrics,tracing,grafana,prometheus',
    domain_tags: 'observability,monitoring,devops',
    capability_summary: 'Observability stack setup with logging metrics tracing Grafana and Prometheus',
    trigger_patterns: 'when user needs observability monitoring setup Grafana dashboards or logging infrastructure',
  },
  'agent:payment-processing': {
    intent_tags: 'payment,processing,stripe,billing,checkout,subscription,webhook',
    domain_tags: 'payment,billing,ecommerce',
    capability_summary: 'Payment processing integration with Stripe billing subscriptions and checkout flows',
    trigger_patterns: 'when user needs payment processing Stripe integration or billing system setup',
  },
  'agent:performance-testing-review': {
    intent_tags: 'performance,testing,load,benchmark,stress,k6,artillery',
    domain_tags: 'performance,testing,benchmark',
    capability_summary: 'Performance testing with load benchmarking stress testing and bottleneck analysis',
    trigger_patterns: 'when user needs performance testing load testing or benchmark analysis',
  },
  'agent:quantitative-trading': {
    intent_tags: 'quant,trading,finance,algorithm,backtest,strategy,market',
    domain_tags: 'finance,trading,quantitative',
    capability_summary: 'Quantitative trading agent for algorithmic strategies backtesting and market analysis',
    trigger_patterns: 'when user needs quantitative trading algorithms backtesting or market analysis tools',
  },
  'agent:reverse-engineering': {
    intent_tags: 'reverse-engineering,binary,decompile,analysis,disassembly,forensics',
    domain_tags: 'security,reverse-engineering,analysis',
    capability_summary: 'Reverse engineering agent for binary analysis decompilation and forensic investigation',
    trigger_patterns: 'when user needs reverse engineering binary analysis or decompilation assistance',
  },
  'agent:security-compliance': {
    intent_tags: 'security,compliance,soc2,iso,policy,audit,governance',
    domain_tags: 'security,compliance,governance',
    capability_summary: 'Security compliance agent for SOC2 ISO auditing and governance policy creation',
    trigger_patterns: 'when user needs security compliance SOC2 ISO auditing or governance policies',
  },
  'agent:seo-analysis-monitoring': {
    intent_tags: 'seo,analysis,monitoring,ranking,tracking,serp,keywords',
    domain_tags: 'seo,analysis,monitoring',
    capability_summary: 'SEO analysis and monitoring agent for ranking tracking SERP analysis and keyword monitoring',
    trigger_patterns: 'when user needs SEO ranking monitoring SERP analysis or keyword tracking',
  },
  'agent:seo-content-creation': {
    intent_tags: 'seo,content,creation,writing,keywords,optimization,blog',
    domain_tags: 'seo,content,writing',
    capability_summary: 'SEO content creation agent for keyword-optimized articles and blog writing',
    trigger_patterns: 'when user needs SEO-optimized content creation keyword articles or blog writing',
  },
  'agent:seo-technical-optimization': {
    intent_tags: 'seo,technical,optimization,crawl,indexing',
    domain_tags: 'seo,technical',
    capability_summary: 'Technical SEO optimization agent for site speed crawl efficiency and indexing',
    trigger_patterns: 'when user needs technical SEO optimization site speed or crawl improvements',
  },
  'agent:shell-scripting': {
    intent_tags: 'shell,scripting,bash,zsh,automation,cli,devops',
    domain_tags: 'shell,scripting,automation',
    capability_summary: 'Shell scripting agent for bash/zsh automation CLI tools and system administration',
    trigger_patterns: 'when user needs shell scripts bash automation or CLI tool development',
  },
  'agent:startup-business-analyst': {
    intent_tags: 'startup,business,analysis,strategy,market,competitive,research',
    domain_tags: 'business,startup,analysis',
    capability_summary: 'Startup business analysis with market research competitive strategy and growth planning',
    trigger_patterns: 'when user needs startup business analysis market research or competitive strategy',
  },
  'agent:systems-programming': {
    intent_tags: 'systems,programming,rust,c,low-level,memory,performance',
    domain_tags: 'systems,programming,rust,c',
    capability_summary: 'Systems programming agent for Rust C low-level memory management and performance',
    trigger_patterns: 'when user needs systems programming Rust C low-level coding or memory management',
  },
  'agent:team-collaboration': {
    intent_tags: 'team,collaboration,workflow,communication,project,standup,sprint',
    domain_tags: 'team,collaboration,project',
    capability_summary: 'Team collaboration agent for project workflows standups and communication optimization',
    trigger_patterns: 'when user needs team collaboration workflow optimization or project management setup',
  },
  'agent:web-scripting': {
    intent_tags: 'web,scripting,scraping,automation,crawl,extract,parse',
    domain_tags: 'web,scripting,automation',
    capability_summary: 'Web scripting agent for scraping data extraction and web automation tasks',
    trigger_patterns: 'when user needs web scraping data extraction or web automation scripting',
  },
  'skill:audit-website': {
    intent_tags: 'audit,website,accessibility,performance,seo,security,quality',
    domain_tags: 'audit,web,quality',
    capability_summary: 'Comprehensive website audit covering accessibility performance SEO and security',
    trigger_patterns: 'when user needs a comprehensive website audit covering accessibility performance and SEO',
  },
  'agent:academic-researcher': {
    intent_tags: 'academic,research,paper,literature,citation,review,scholar',
    domain_tags: 'research,academic,paper',
    capability_summary: 'Academic research agent for literature review paper analysis and citation management',
    trigger_patterns: 'when user needs academic research literature review or paper analysis assistance',
  },
  'agent:code-reviewer': {
    intent_tags: 'code,reviewer,quality,bugs,analysis,patterns,best-practices',
    domain_tags: 'quality,review,code',
    capability_summary: 'Code review agent for bug detection quality analysis and best practice enforcement',
    trigger_patterns: 'when user needs automated code review bug detection or quality analysis',
  },
  'agent:content-creator': {
    intent_tags: 'content,creator,writing,generate,creative,article,blog',
    domain_tags: 'content,writing,creative',
    capability_summary: 'Content creation agent for articles blog posts and creative writing generation',
    trigger_patterns: 'when user needs content creation article writing or creative content generation',
  },
  'agent:data-analyst': {
    intent_tags: 'data,analyst,analysis,visualization,statistics,charts,insights',
    domain_tags: 'data,analysis,visualization',
    capability_summary: 'Data analysis agent with statistical analysis visualization and insight generation',
    trigger_patterns: 'when user needs data analysis statistical processing or data visualization',
  },
  'agent:debugger': {
    intent_tags: 'debugger,bug,fix,error,diagnosis,trace,root-cause',
    domain_tags: 'debugging,error,fix',
    capability_summary: 'Debugging agent for automated bug diagnosis error tracing and fix suggestions',
    trigger_patterns: 'when user needs automated debugging bug diagnosis or error tracing',
  },
  'agent:decision-helper': {
    intent_tags: 'decision,helper,analysis,pros-cons,evaluate,compare,trade-off',
    domain_tags: 'decision,analysis,evaluation',
    capability_summary: 'Decision analysis helper with pros/cons evaluation trade-off comparison and recommendations',
    trigger_patterns: 'when user needs help making decisions evaluating options or comparing trade-offs',
  },
  'agent:deep-research': {
    intent_tags: 'research,deep,investigation,analysis,comprehensive,web,synthesis',
    domain_tags: 'research,investigation,analysis',
    capability_summary: 'Deep research agent for comprehensive investigation web analysis and synthesis',
    trigger_patterns: 'when user needs deep research comprehensive investigation or thorough analysis',
  },
  'agent:editor': {
    intent_tags: 'editor,writing,proofread,grammar,style,clarity,tone',
    domain_tags: 'writing,editing,quality',
    capability_summary: 'Writing editor agent for proofreading grammar correction style and clarity improvement',
    trigger_patterns: 'when user needs writing editing proofreading or grammar correction',
  },
  'agent:email-drafter': {
    intent_tags: 'email,drafter,writing,professional,communication,template,reply',
    domain_tags: 'email,writing,communication',
    capability_summary: 'Email drafting agent for professional communication templates and reply composition',
    trigger_patterns: 'when user needs email drafting professional communication or email template creation',
  },
  'agent:fact-checker': {
    intent_tags: 'fact-check,verify,accuracy,claims,source,evidence,truth',
    domain_tags: 'fact-check,verification,accuracy',
    capability_summary: 'Fact-checking agent for verifying claims checking sources and assessing accuracy',
    trigger_patterns: 'when user needs fact-checking claim verification or source accuracy assessment',
  },
  'agent:fullstack-developer': {
    intent_tags: 'fullstack,developer,frontend,backend,web,react,node',
    domain_tags: 'fullstack,web,development',
    capability_summary: 'Full-stack developer agent for frontend backend and complete web application building',
    trigger_patterns: 'when user needs full-stack web development frontend and backend integration',
  },
  'agent:meeting-notes': {
    intent_tags: 'meeting,notes,summary,action-items,minutes,transcript,decisions',
    domain_tags: 'meeting,notes,productivity',
    capability_summary: 'Meeting notes agent for summarizing discussions extracting action items and decisions',
    trigger_patterns: 'when user needs meeting notes summaries action item extraction or minutes generation',
  },
  'agent:project-planner': {
    intent_tags: 'project,planner,roadmap,timeline,milestones,tasks,breakdown',
    domain_tags: 'project,planning,management',
    capability_summary: 'Project planning agent for roadmaps timeline creation and milestone task breakdown',
    trigger_patterns: 'when user needs project planning roadmap creation or task breakdown with milestones',
  },
  'agent:python-expert': {
    intent_tags: 'python,expert,advanced,optimization,patterns,best-practices',
    domain_tags: 'python,expert,development',
    capability_summary: 'Python expert agent for advanced patterns optimization and best practice guidance',
    trigger_patterns: 'when user needs expert Python advice advanced patterns or performance optimization',
  },
  'agent:sprint-planner': {
    intent_tags: 'sprint,planner,agile,scrum,backlog,estimation,velocity',
    domain_tags: 'agile,sprint,planning',
    capability_summary: 'Sprint planning agent for backlog grooming story estimation and velocity tracking',
    trigger_patterns: 'when user needs sprint planning backlog grooming or agile estimation',
  },
  'agent:strategy-advisor': {
    intent_tags: 'strategy,advisor,business,consulting,planning,analysis,recommendation',
    domain_tags: 'strategy,business,consulting',
    capability_summary: 'Strategy advisor agent for business consulting analysis and strategic recommendations',
    trigger_patterns: 'when user needs strategic business advice consulting analysis or planning guidance',
  },
  'agent:technical-writer': {
    intent_tags: 'technical,writer,documentation,api-docs,guides,tutorials,reference',
    domain_tags: 'documentation,technical-writing,guides',
    capability_summary: 'Technical writing agent for API docs user guides tutorials and reference documentation',
    trigger_patterns: 'when user needs technical writing API documentation user guides or tutorials',
  },
  'agent:ux-designer': {
    intent_tags: 'ux,designer,user-experience,wireframe,usability,persona,journey',
    domain_tags: 'ux,design,user-experience',
    capability_summary: 'UX design agent for wireframing user research persona creation and usability analysis',
    trigger_patterns: 'when user needs UX design wireframing user research or usability analysis',
  },
  'agent:visualization-expert': {
    intent_tags: 'visualization,charts,graphs,data-viz,d3,dashboard,infographic',
    domain_tags: 'visualization,data,charts',
    capability_summary: 'Data visualization expert for charts dashboards infographics and interactive displays',
    trigger_patterns: 'when user needs data visualization charts dashboards or interactive graph creation',
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
      invocation_name = CASE WHEN ? != '' THEN ? ELSE invocation_name END,
      updated_at = datetime('now')
    WHERE type = ? AND name = ?
  `);

  rdb.transaction(() => {
    for (const [key, meta] of Object.entries(RESOURCE_METADATA)) {
      const [type, name] = key.split(':');
      const invName = meta.invocation_name || '';
      update.run(
        meta.intent_tags, meta.domain_tags,
        meta.capability_summary, meta.trigger_patterns,
        invName, invName,
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
    'hook.mjs', 'hook-shared.mjs', 'hook-llm.mjs', 'hook-memory.mjs',
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
    // Remove project-level registration that shadows global (from .mcp.json)
    try { execFileSync('claude', ['mcp', 'remove', '-s', 'project', 'mem'], { stdio: 'pipe' }); } catch {}
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
                invocation_name: meta?.invocation_name || '',
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
        // FTS5 integrity check (requires read-write access for INSERT INTO fts VALUES('integrity-check'))
        try {
          const { checkFTSIntegrity, rebuildFTS } = await import('./schema.mjs');
          const rwDb = new Database(DB_PATH);
          rwDb.pragma('busy_timeout = 3000');
          try {
            const { healthy, details } = checkFTSIntegrity(rwDb);
            if (healthy) {
              ok('FTS5 integrity: all indexes healthy');
            } else {
              warn('FTS5 integrity issues detected:');
              for (const d of details) log(`    ${d}`);
              log('  Attempting FTS5 rebuild...');
              const { rebuilt, errors } = rebuildFTS(rwDb);
              if (rebuilt.length > 0) ok(`FTS5 rebuilt: ${rebuilt.join(', ')}`);
              if (errors.length > 0) { fail(`FTS5 rebuild errors: ${errors.join(', ')}`); issues++; }
            }
          } finally {
            rwDb.close();
          }
        } catch (e) {
          warn('FTS5 integrity check failed: ' + e.message);
        }
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
