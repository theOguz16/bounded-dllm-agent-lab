# Product Benchmark V1

`benchmarks/product-v1/tasks/` contains provider-visible task manifests.

`benchmarks/product-v1/evaluator/` contains evaluator-only material such as expected changed files, oracle assertions, or expected patch references. Evaluator material is never embedded in a provider-visible task manifest.

Public task files use `product-task/v1` and contain exactly:

- `schemaVersion`
- `taskId`
- `family`
- `repo`
- `commitSha`
- `objective`
- `acceptanceCriteria`
- `validationCommands`

Supported families:

- `existing_function_bug_fix`
- `bounded_behavior_change`
- `regression_test_addition`

A benchmark runner must load the public task first and construct provider input only through `createProductTaskProviderInput()`. Evaluator data is loaded separately after provider execution and must not be concatenated into model context.
