
function xml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
export function buildReadOnlyPackagePrompt(packageSpec, context = {}) {
  return [
    `<orchestration_package_id>${xml(packageSpec.id)}</orchestration_package_id>`,
    `<role>${xml(packageSpec.role.class)}: ${xml(packageSpec.role.label)}</role>`,
    `<objective>${xml(packageSpec.objective)}</objective>`,
    `<access_policy>Read-only. Do not modify files, create commits, change credentials, push, publish, deploy, or mutate remote systems.</access_policy>`,
    `<dependencies>${xml(JSON.stringify(context.dependencyResults ?? []))}</dependencies>`,
    `<acceptance_criteria>${xml(JSON.stringify(packageSpec.acceptanceCriteria))}</acceptance_criteria>`,
    `<native_subagent_policy>${xml(`${packageSpec.nativeSubagents.policy}; maximum ${packageSpec.nativeSubagents.maxChildren} child agents`)}</native_subagent_policy>`,
    `<verification>Run only non-destructive checks needed to support claims. Record exact commands and exit codes.</verification>`,
    `<output_contract>Return exactly one JSON object matching the supplied package-result schema. changedFiles must be an empty array.</output_contract>`
  ].join("\n\n");
}
