import { auditFixturesForOracleLeakage } from "../../../packages/oracle-audit/src/index.js";
import { demoFixtures } from "../../../packages/fixtures/src/index.js";

const result = auditFixturesForOracleLeakage(demoFixtures);

console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  // Bu CLI'ın fail etmesi bilinçlidir. Oracle leakage varsa benchmark sonucu
  // istatistiksel olarak güzel görünse bile bilimsel olarak savunulamaz.
  process.exitCode = 1;
}
