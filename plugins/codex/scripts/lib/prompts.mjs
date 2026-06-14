import fs from "node:fs";
import path from "node:path";

export function loadPromptTemplate(rootDir, name) {
  const promptPath = path.join(rootDir, "prompts", `${name}.md`);
  let template = fs.readFileSync(promptPath, "utf8");
  // House overlay (ours, not upstream's): if prompts/overlays/<name>.md exists, append it so
  // our review/critique conventions ride ON TOP of the upstream prompt without editing it —
  // `git pull upstream` never conflicts on the prompt scaffold; only this loader is a small,
  // stable fork change. The overlay carries no {{TOKENS}}, so interpolation leaves it intact.
  const overlayPath = path.join(rootDir, "prompts", "overlays", `${name}.md`);
  if (fs.existsSync(overlayPath)) {
    const overlay = fs.readFileSync(overlayPath, "utf8").trim();
    if (overlay) {
      template += `\n\n<house_conventions>\n${overlay}\n</house_conventions>\n`;
    }
  }
  return template;
}

export function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : "";
  });
}
