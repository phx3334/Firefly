import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { getPostUrlBySlug, removeFileExtension } from "@/utils/url-utils";

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

export async function GET(): Promise<Response> {
	const posts = await getCollection("posts");
	const items = posts
		.filter((p) => !p.data.draft && !p.data.password)
		.sort((a, b) => {
			const da = a.data.published?.getTime() ?? 0;
			const db = b.data.published?.getTime() ?? 0;
			return db - da;
		})
		.map((p) => {
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
			};
		});

	return new Response(JSON.stringify(items), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
}
