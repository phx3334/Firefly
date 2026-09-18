// 正文块锚点：给正文里可定位的块级元素（段落、列表项、标题、引用块等）
// 分配 id，使搜索结果能通过 URL hash 直接跳到「关键字所在的那一行」。
//
// id 策略：
// - 标题：github slug（与 rehype-slug 的产物一致，正文端标题已有 id 时直接保留）；
// - 其他块：b-<内容 sha1 前 10 位>。哈希只取决于块文本，与块的数量、顺序无关——
//   搜索索引端用精简管线解析同一段 Markdown，只要某块在两端文本一致，id 就相同，
//   因此即使两套解析管线的其他插件不同（directive/sectionize 等）也不会错位。
// 文本完全相同的块出现多次时，加 -N 后缀消歧。

import { createHash } from "node:crypto";
import { toString } from "hast-util-to-string";
import GithubSlugger from "github-slugger";
import { visit } from "unist-util-visit";

// 可定位的块级元素（pre 代码块刻意排除：搜索不索引代码）
const BLOCK_TAGS = new Set([
	"p",
	"li",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"dd",
	"dt",
	"td",
]);

const HEADING_RE = /^h[1-6]$/;

function normalize(text) {
	return text.replace(/\s+/g, " ").trim();
}

function createIdResolver() {
	const slugger = new GithubSlugger();
	const seen = new Map();
	return (node) => {
		const text = normalize(toString(node));
		if (!text) return null;
		let base;
		if (HEADING_RE.test(node.tagName)) {
			base = slugger.slug(text);
		} else {
			base = `b-${createHash("sha1").update(text).digest("hex").slice(0, 10)}`;
		}
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		return count === 0 ? base : `${base}-${count}`;
	};
}

// 给树中所有可定位块分配 id；已有 id（如 rehype-slug 处理过的标题）保留不覆盖
export function assignBlockIds(tree) {
	const resolveId = createIdResolver();
	visit(tree, "element", (node) => {
		if (!BLOCK_TAGS.has(node.tagName)) return;
		if (node.properties?.id) return;
		const id = resolveId(node);
		if (id) {
			node.properties = { ...(node.properties ?? {}), id };
		}
	});
	return tree;
}

// 收集块索引（文档顺序）：[{ id, text, headingId }]
// headingId = 该块上方最近标题的 id（标题块指向自身），搜索命中后据此
// 跳到「距离关键字最近的小标题」；标题之前的块为 null（退到文章顶部）。
export function collectBlocks(tree) {
	const blocks = [];
	let currentHeadingId = null;
	visit(tree, "element", (node) => {
		if (!BLOCK_TAGS.has(node.tagName)) return;
		const id = node.properties?.id;
		const text = normalize(toString(node));
		if (!id || !text) return;
		if (HEADING_RE.test(node.tagName)) currentHeadingId = id;
		blocks.push({ id, text, headingId: currentHeadingId });
	});
	return blocks;
}

// rehype 插件。
// options.collect = true 时，把 [{id, text}] 收集到 file.data.blocks，
// 供搜索索引端在「与正文渲染完全相同的树状态」下提取块。
export default function rehypeBlockAnchors(options = {}) {
	return (tree, file) => {
		assignBlockIds(tree);
		if (options.collect && file) {
			file.data.blocks = collectBlocks(tree);
		}
	};
}
