/* 新建一条动态，直接写入 src/data/dynamics.ts（前端硬编码数据源）。
 *
 * 创建时间通过 scripts/time-utils.ts 生成：
 * - 统一使用站点时区（默认 Asia/Shanghai / 北京时间）
 * - 冻结在创建那一刻，不会随时间自增
 *
 * 用法: pnpm new-dynamic <内容>
 */
import fs from "node:fs";
import path from "node:path";
import { nowUtcMs, getLocalParts } from "./time-utils.ts";

const content = process.argv.slice(2).join(" ").trim();

if (!content) {
	console.error(
		"Error: No dynamic content provided\nUsage: pnpm new-dynamic <content>",
	);
	process.exit(1);
}

const parts = getLocalParts();
const id = `local-${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
const published = nowUtcMs();
const file = path.resolve("src/data/dynamics.ts");
const raw = fs.readFileSync(file, "utf-8");

const entry = `	{
		id: ${JSON.stringify(id)},
		// ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} (${"site timezone"})
		published: ${published},
		html: ${JSON.stringify(content)},
		images: [],
		searchText: ${JSON.stringify(content)},
		pinned: false,
	},
`;

// 插到数组结束的 "];" 之前
const marker = "];";
const idx = raw.lastIndexOf(marker);
if (idx === -1) {
	console.error(`Error: cannot find array end in ${file}`);
	process.exit(1);
}
const next = raw.slice(0, idx) + entry + raw.slice(idx);
fs.writeFileSync(file, next);

console.log(
	`Dynamic added: ${id} (${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second})`,
);
