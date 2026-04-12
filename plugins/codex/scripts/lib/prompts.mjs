import fs from "node:fs";
import path from "node:path";

export function loadPromptTemplate(rootDir, name) {
  const promptPath = path.join(rootDir, "prompts", `${name}.md`);
  return fs.readFileSync(promptPath, "utf8");
}

export function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : "";
  });
}

const INFRA_EXTENSIONS = new Set([".tf", ".tfvars", ".hcl"]);
const INFRA_FILENAMES = new Set(["Dockerfile", "docker-compose.yml", "docker-compose.yaml"]);
const INFRA_PATH_PATTERNS = [
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
  /helm\//,
  /charts\//,
  /k8s\//,
  /kubernetes\//,
  /kustomize\//,
  /argocd\//,
  /\.circleci\//,
  /Jenkinsfile$/
];

/**
 * Detect whether a set of changed files represents infrastructure, application, or mixed code.
 * @param {string[]} changedFiles
 * @returns {"infra" | "app" | "mixed"}
 */
export function detectReviewDomain(changedFiles) {
  let hasInfra = false;
  let hasApp = false;

  for (const file of changedFiles) {
    const ext = path.extname(file).toLowerCase();
    const basename = path.basename(file);

    if (
      INFRA_EXTENSIONS.has(ext) ||
      INFRA_FILENAMES.has(basename) ||
      basename.startsWith("docker-compose") ||
      INFRA_PATH_PATTERNS.some((pattern) => pattern.test(file))
    ) {
      hasInfra = true;
    } else {
      hasApp = true;
    }

    if (hasInfra && hasApp) {
      return "mixed";
    }
  }

  if (hasInfra) return "infra";
  if (hasApp) return "app";
  return "app";
}

const INFRA_FOCUS_AREAS = [
  "1. STATE CORRUPTION: What if apply is interrupted mid-way? Partial state? Orphaned resources?",
  "2. BLAST RADIUS: What other resources/accounts/environments does this touch? Cascade risk?",
  "3. IAM/PERMISSIONS: Privilege escalation paths? Over-permissive policies? Cross-account trust?",
  "4. PROVIDER DRIFT: Version constraints too loose? Breaking changes in minor versions? Deprecated resources?",
  "5. DEPENDENCY ORDERING: Resources created in wrong order? Implicit dependencies not declared?",
  "6. ROLLBACK: Can this be safely reverted? What is the rollback procedure? Any one-way doors?",
  "7. RACE CONDITIONS: Concurrent applies? State locking gaps? Eventually-consistent APIs?",
  "8. COST: Unexpected cost implications? Resources that scale unexpectedly?",
  "9. OBSERVABILITY: Will this change break existing alerting or create monitoring gaps for new resources?"
];

const APP_FOCUS_AREAS = [
  "1. EDGE CASES: Inputs that break assumptions, boundary conditions, empty/null/oversized data",
  "2. SECURITY: OWASP Top 10 vulnerabilities, injection points, auth bypass, data exposure",
  "3. CONCURRENCY: Race conditions, deadlocks, shared mutable state, non-atomic operations",
  "4. FAILURE MODES: What happens under load? Network partitions? Dependency failures? Timeouts?",
  "5. DATA INTEGRITY: Migrations that lose data, inconsistent state, missing constraints",
  "6. ROLLBACK: Can this be deployed and rolled back safely? Any one-way schema changes?",
  "7. OBSERVABILITY: Will this change break existing alerting or create blind spots?"
];

const INFRA_LIGHT_INDICES = [0, 1, 2];
const APP_LIGHT_INDICES = [0, 1, 2];

/**
 * Get the challenge focus areas for the given domain and depth.
 * @param {"infra" | "app" | "mixed"} domain
 * @param {"light" | "standard" | "deep"} depth
 * @returns {string}
 */
export function getChallengeFocusAreas(domain, depth) {
  let areas;

  if (domain === "infra") {
    areas = depth === "light"
      ? INFRA_LIGHT_INDICES.map((i) => INFRA_FOCUS_AREAS[i])
      : INFRA_FOCUS_AREAS;
  } else if (domain === "app") {
    areas = depth === "light"
      ? APP_LIGHT_INDICES.map((i) => APP_FOCUS_AREAS[i])
      : APP_FOCUS_AREAS;
  } else {
    // mixed: all infra + non-overlapping app areas (edge cases, security, concurrency, failure modes, data integrity)
    const appExtras = APP_FOCUS_AREAS.filter(
      (area) => !area.includes("ROLLBACK") && !area.includes("OBSERVABILITY")
    );
    areas = depth === "light"
      ? [...INFRA_LIGHT_INDICES.map((i) => INFRA_FOCUS_AREAS[i]), ...APP_LIGHT_INDICES.map((i) => APP_FOCUS_AREAS[i])]
      : [...INFRA_FOCUS_AREAS, ...appExtras];
  }

  return areas.join("\n");
}

/**
 * Determine review depth from diff line count.
 * @param {number} diffLines
 * @returns {"light" | "standard" | "deep"}
 */
export function getDiffDepth(diffLines) {
  if (diffLines < 50) return "light";
  if (diffLines < 200) return "standard";
  return "deep";
}

/**
 * Get depth instructions for the challenge prompt.
 * @param {"light" | "standard" | "deep"} depth
 * @param {number} diffLines
 * @returns {string}
 */
export function getDepthInstructions(depth, diffLines) {
  switch (depth) {
    case "light":
      return `This is a small change (~${diffLines} lines). Focus only on the highest-risk areas listed above. Skip style and cost concerns.`;
    case "standard":
      return `This is a moderate change (~${diffLines} lines). Cover all focus areas listed above.`;
    case "deep":
      return `This is a large change (~${diffLines} lines). Be exhaustive. Cover all focus areas and look for interactions between changed components. Trace failure chains across file boundaries.`;
    default:
      return "";
  }
}

/**
 * Get the review domain label for the challenge prompt.
 * @param {"infra" | "app" | "mixed"} domain
 * @returns {string}
 */
export function getReviewDomainLabel(domain) {
  switch (domain) {
    case "infra":
      return "infrastructure";
    case "app":
      return "application code";
    case "mixed":
      return "infrastructure and application code";
    default:
      return "code";
  }
}
