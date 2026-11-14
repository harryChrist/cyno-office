import { loadConfig } from "../../config";
import { seedDataDir } from "./seed";
import { rootPaths } from "../../store/paths";

const force = process.argv.includes("--force");
const { dataDir } = loadConfig();
const { created } = await seedDataDir(dataDir, { force });

if (created) {
  console.log(`Dados iniciais criados em ${dataDir}`);
} else {
  console.log(`${rootPaths(dataDir).workspacesFile} já existe. Use --force para recriar.`);
}
