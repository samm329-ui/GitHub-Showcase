/**
 * Script dataset CLI — list or inspect the archived narration scripts.
 *
 *   npm run scripts:list -- github     # every GitHub-channel script, oldest first
 *   npm run scripts:list -- news
 *   npm run scripts:show -- github <id>  # the full record as JSON
 *
 * The dataset lives in `dataset/<channel>/<id>.json` (gitignored); the
 * committed format contract is `dataset/README.md`.
 */
import {
  listDatasetRecords,
  getDatasetRecord,
  type DatasetChannel,
} from "../src/script-dataset.js";

const [command, ...rest] = process.argv.slice(2);

function usage(): never {
  console.error(
    "usage:\n" +
      "  npm run scripts:list -- [github|news]     show the index (id, phase, title, createdAt)\n" +
      "  npm run scripts:show -- <github|news> <id>  print the full record as JSON"
  );
  process.exit(2);
}

function channelOf(v: string | undefined): DatasetChannel {
  if (v === "github" || v === "news") return v;
  usage();
}

if (command === "list") {
  const channel = channelOf(rest[0]);
  const entries = await listDatasetRecords(channel);
  if (entries.length === 0) {
    console.log(`dataset/${channel}/ is empty — scripts appear here after each run.`);
    process.exit(0);
  }
  const phaseWidth = Math.max(...entries.map(e => e.phase.length));
  for (const entry of entries) {
    console.log(
      `${entry.id.padEnd(38)} ${entry.phase.padEnd(phaseWidth)} ${entry.createdAt}  ${entry.title}`
    );
  }
  console.log(`\n${entries.length} record(s).  npm run scripts:show -- ${channel} <id> for full detail.`);
} else if (command === "show") {
  const channel = channelOf(rest[0]);
  const id = rest[1];
  if (!id) usage();
  const record = await getDatasetRecord(channel, id);
  if (!record) {
    console.error(`no dataset record for ${channel}/${id}`);
    process.exit(1);
  }
  console.log(JSON.stringify(record, null, 2));
} else {
  usage();
}
