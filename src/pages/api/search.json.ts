import { getCollection } from "astro:content";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkSmartypants from "remark-smartypants";
import remarkRehype from "remark-rehype";
import { getPostUrlBySlug, removeFileExtension } from "@/utils/url-utils";
import type { SearchBlockEntry } from "@/plugins/rehype-block-anchors.mjs";
import {
	getRehypePlugins,
	getRemarkPlugins,
} from "@/plugins/markdown-pipeline.mjs";

// 将 Markdown 源文转换为纯文本，便于检索与生成摘要。
// 排除代码块（``` / ~~~ 围栏、行内 `code`）与图表（图片、SVG、<picture>），
// 仅保留正文文字，避免搜索命中代码与图表内容。
function stripMarkdown(md: string): string {
	return md
		.replace(/```[\s\S]*?```/g, " ") // 围栏代码块 ```
		.replace(/~~~[\s\S]*?~~~/g, " ") // 围栏代码块 ~~~
		.replace(/`[^`]*`/g, " ") // 行内代码
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // 图片
		.replace(/<svg[\s\S]*?<\/svg>/gi, " ") // 内联 SVG 图表
		.replace(/<picture[\s\S]*?<\/picture>/gi, " ") // <picture> 图表
		.replace(/<img\b[^>]*>/gi, " ") // HTML <img> 图片
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接保留文字
		.replace(/^#{1,6}\s+/gm, "") // 标题符号
		.replace(/[*_~>]/g, " ") // 强调符号
		.replace(/^\s*[-*+]\s+/gm, "") // 列表符号
		.replace(/<[^>]+>/g, " ") // 其余 HTML 标签
		.replace(/\s+/g, " ")
		.trim();
}

// 管线插件条目来自无类型的 .mjs 共享模块（插件或 [插件, 配置] 元组），
// 这里只负责透传给 unified，用 any 承接，不引入额外类型约束。
// biome-ignore lint/suspicious/noExplicitAny: 共享管线插件的透传胶水代码
type AnyPlugin = any;
// biome-ignore lint/suspicious/noExplicitAny: 共享管线插件的透传胶水代码
function applyPlugins(proc: AnyPlugin, plugins: AnyPlugin[]): AnyPlugin {
	for (const entry of plugins) {
		if (Array.isArray(entry)) proc.use(entry[0], entry[1]);
		else proc.use(entry);
	}
	return proc;
}

// 块索引解析器：与 Astro 正文渲染同一套插件、同一顺序
// （parse → gfm → smartypants → 用户 remark → remark-rehype → 用户 rehype），
// rehype-block-anchors 在 collect 模式下把 [{id, text}] 写入 vfile.data.blocks。
// biome-ignore lint/suspicious/noExplicitAny: unified 处理器透传
const blockProcessor: AnyPlugin = applyPlugins(
	applyPlugins(
		unified().use(remarkParse).use(remarkGfm).use(remarkSmartypants),
		getRemarkPlugins(),
	).use(remarkRehype, { allowDangerousHtml: true }),
	getRehypePlugins({ collectBlocks: true }),
);

async function extractBlocks(markdown: string): Promise<SearchBlockEntry[]> {
	const tree = blockProcessor.parse(markdown);
	// vfile 只需承载各插件读写的 data：reading-time/excerpt 写 data.astro.frontmatter，
	// block-anchors(collect) 写 data.blocks
	const file: {
		data: {
			astro: { frontmatter: Record<string, unknown> };
			blocks?: SearchBlockEntry[];
		};
	} = { data: { astro: { frontmatter: {} } } };
	await blockProcessor.run(tree, file);
	return file.data.blocks ?? [];
}

export async function GET(): Promise<Response> {
	const posts = await getCollection("posts");
	const items = await Promise.all(
		posts
			.filter((p) => !p.data.draft && !p.data.password)
			.sort((a, b) => {
				const da = a.data.published?.getTime() ?? 0;
				const db = b.data.published?.getTime() ?? 0;
				return db - da;
			})
			.map(async (p) => {
				const content = stripMarkdown(p.body ?? "");
				return {
					url: getPostUrlBySlug(removeFileExtension(p.id)),
					title: p.data.title,
					description: p.data.description ?? "",
					tags: p.data.tags ?? [],
					date: p.data.published
						? p.data.published.toISOString().slice(0, 10)
						: "",
					excerpt: content.slice(0, 160),
					content,
					blocks: await extractBlocks(p.body ?? ""),
				};
			}),
	);

	return new Response(JSON.stringify(items), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			// 索引结构会随代码迭代（如 blocks.headingId），用 no-cache 让浏览器
			// 每次带 ETag 校验：内容没变走 304 几乎零开销，变了立即拿到新索引
			"Cache-Control": "no-cache",
		},
	});
}
