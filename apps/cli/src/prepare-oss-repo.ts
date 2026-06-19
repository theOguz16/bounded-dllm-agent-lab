import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

type OssRepositoryConfig = {
  id: string;
  name: string;
  url: string;
  commit: string;
  license: string;
  localPath: string;
  packageManager: string;
  installCommand: string;
  testCommand: string;
  fastCheckCommand: string;
  benchmarkReason: string;
};

type OssRepositoriesFile = {
  repositories: OssRepositoryConfig[];
};

const configPath = "benchmarks/oss-repositories.json";
const requestedId = process.argv[2] ?? "nanoid";
const configFile = JSON.parse(await readFile(configPath, "utf8")) as OssRepositoriesFile;
const repository = configFile.repositories.find((item) => item.id === requestedId);

if (!repository) {
  throw new Error(`Unknown OSS repository id: ${requestedId}`);
}

await prepareRepository(repository);

console.log(
  JSON.stringify(
    {
      ok: true,
      id: repository.id,
      name: repository.name,
      commit: repository.commit,
      localPath: repository.localPath,
      installCommand: repository.installCommand,
      testCommand: repository.testCommand,
      fastCheckCommand: repository.fastCheckCommand
    },
    null,
    2
  )
);

async function prepareRepository(repository: OssRepositoryConfig): Promise<void> {
  await mkdir(dirname(repository.localPath), { recursive: true });

  if (!existsSync(join(repository.localPath, ".git"))) {
    // Üçüncü taraf repoyu ana repoya commit etmiyoruz. Bu komut pinli commit'i
    // çalışma klasörüne indirir; böylece benchmark tekrar üretilebilir kalır ama
    // bizim araştırma reposu gereksiz OSS koduyla şişmez.
    run("git", ["clone", repository.url, repository.localPath]);
  }

  run("git", ["fetch", "--all", "--tags"], repository.localPath);
  run("git", ["checkout", repository.commit], repository.localPath);
  run("git", ["reset", "--hard", repository.commit], repository.localPath);

  const actualCommit = run("git", ["rev-parse", "HEAD"], repository.localPath).trim();
  if (actualCommit !== repository.commit) {
    throw new Error(`Pinned commit mismatch for ${repository.id}: expected ${repository.commit}, got ${actualCommit}`);
  }
}

function run(command: string, args: string[], cwd = "."): string {
  // execFileSync shell interpolation kullanmadığı için repo URL ve path değerleri
  // shell string'i olarak çalıştırılmaz. Bu küçük güvenlik tercihi prepare komutunu
  // daha tahmin edilebilir yapar.
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
