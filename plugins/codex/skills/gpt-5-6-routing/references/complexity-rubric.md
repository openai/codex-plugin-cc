# Complexity Rubric

Use this rubric only for a fresh rescue task and only to classify values the
user did not provide.

## Evaluation dimensions

Evaluate the task's breadth and affected surface, ambiguity and required
exploration, reversibility and risk, and the depth of verification needed.
Consider implementation or diagnosis depth as supporting evidence.
Evaluate required autonomy by distinguishing tightly bounded work from work
that needs a long autonomous run.

## Classes

### Small and bounded

The affected surface is known, the change is reversible, and verification is
simple.

### Normal and bounded

The task needs limited exploration, touches a few coordinated files, and uses
standard diagnosis and verification.

### Broad, ambiguous, or high-value

The task spans multiple components, needs meaningful exploration, has higher
impact, or requires substantial verification.

### Architectural, high-risk, or unusually difficult

The task involves cross-cutting decisions, hard-to-reverse consequences,
complex dependencies, or exceptional verification.

## Uncertainty

A boundary ambiguity means the available facts support two adjacent classes;
select the higher class. Insufficient task information means the facts do not
support any class; produce no classification and leave the missing value unset.
