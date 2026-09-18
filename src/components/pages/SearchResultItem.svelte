<script lang="ts">
import { navigateToPage } from "@utils/navigation-utils";
import Icon from "@/components/common/Icon.svelte";

// 单条搜索结果：标题（高亮）+ 两行摘要（高亮）。
// 导航栏搜索浮层与 /search 结果页共用，保证「展示更多」后的列表与浮层格式一致。
export let url: string;
export let titleHtml: string;
export let snippetHtml: string;
// 点击跳转前的回调（导航栏浮层用于关闭面板）
export let onNavigate: (() => void) | undefined = undefined;

const handleClick = (event: Event): void => {
	event.preventDefault();
	onNavigate?.();
	navigateToPage(url);
};
</script>

<a
	href={url}
	on:click={handleClick}
	class="search-result-item flex flex-col gap-1 rounded-xl px-3 py-3 transition-colors"
>
	<div class="search-result-title flex items-center gap-1.5 text-base font-bold">
		<span>{@html titleHtml}</span>
		<Icon icon="fa7-solid:arrow-right" class="shrink-0" />
	</div>
	<div class="line-clamp-2 text-sm opacity-60">{@html snippetHtml}</div>
</a>

<style>
	/* 跟随父容器文字色：黑色搜索浮层上是白字白 hover，页面正文区是深色字深 hover，
	   同一套样式无需关心主题与挂载位置 */
	.search-result-item:hover {
		background: color-mix(in srgb, currentColor 8%, transparent);
	}
</style>
