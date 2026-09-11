# Hidden Evaluator Data

Files in this directory are evaluator-only and must never be included in provider/model input.

The public benchmark task is loaded from `../tasks/<task>.json` and validated through `product-task/v1` first. Hidden evaluator material is loaded separately by task id only after provider execution.

Allowed evaluator-only examples include expected changed files, oracle assertions, or expected patch references. None of these fields belong in the public task contract.
