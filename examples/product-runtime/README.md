# Product Runtime Examples

Bu klasör ilk ürün runtime'ını model çağırmadan denemek için küçük ve
deterministik örnekler içerir.

Her örnek aynı policy dosyasını kullanır:

```bash
npm run build
npm run product:review -- \
  --task examples/product-runtime/tasks/release-metadata.md \
  --diff examples/product-runtime/diffs/remask-required.diff \
  --policy examples/product-runtime/policies/release-policy.yml
```

## Expected Decisions

| Diff | Beklenen Karar | Neden |
| --- | --- | --- |
| `approve.diff` | `approve` | `package.json` ve `jsr.json` birlikte güncellenir. |
| `remask-required.diff` | `remask_required` | `package.json` güncellenir ama paired `jsr.json` eksiktir. |
| `reject-forbidden.diff` | `reject` | Forbidden runtime dosyasına ve sensitive pattern'e dokunur. |
| `refuse-missing-authority.diff` | `refuse` | Eksik product authority varken runtime default değiştirir. |
| `human-review-empty.diff` | `human_review_required` | Diff içinde değişen dosya yoktur. |

## Repository Dogfood Examples

Bu örnekler kökteki `bounded-agent.policy.yml` dosyasını kullanır:

| Diff | Beklenen Karar | Neden |
| --- | --- | --- |
| `repo-docs-approve.diff` | `approve` | Sadece izinli docs alanını değiştirir. |
| `repo-package-remask.diff` | `remask_required` | `package.json` değişir ama `package-lock.json` eksiktir. |
| `repo-sensitive-reject.diff` | `reject` | `reports/**` forbidden scope ve sensitive pattern içerir. |

Örnek:

```bash
npm run product:review -- \
  --task examples/product-runtime/tasks/repo-dogfood.md \
  --diff examples/product-runtime/diffs/repo-package-remask.diff \
  --policy bounded-agent.policy.yml \
  --format both
```

Bu örnekler ürün felsefesini gösterir: runtime model seçmez, önce context,
authority, scope ve repair kararını yapılandırır.
