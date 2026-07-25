<script lang="ts">
import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";
import { navigateToPage } from "@utils/navigation-utils";
import { onMount } from "svelte";
import Icon from "@/components/common/Icon.svelte";
import { getSearchUrl } from "@/utils/url-utils";
import {
	loadSearchIndex,
	searchPosts,
	highlight,
	buildSnippet,
	type SearchPost,
} from "@/utils/search-client";

let keywordDesktop = "";
let keywordMobile = "";
let result: { url: string; titleHtml: string; snippetHtml: string }[] = [];
let isSearching = false;
let initialized = false;
let index: SearchPost[] = [];
let debounceTimer: ReturnType<typeof setTimeout>;

const setPanelVisibility = (show: boolean, isDesktop: boolean): void => {
	const panel = document.getElementById("search-panel");
	if (
		!panel ||
		(isDesktop && !keywordDesktop) ||
		(!isDesktop && !keywordMobile)
	)
		return;
	show
		? panel.classList.remove("float-panel-closed")
		: panel.classList.add("float-panel-closed");
};

const closeSearchPanel = (): void => {
	document
		.getElementById("search-panel")
		?.classList.add("float-panel-closed");
	keywordDesktop = "";
	keywordMobile = "";
	result = [];
};

const handleResultClick = (event: Event, target: string): void => {
	event.preventDefault();
	closeSearchPanel();
	navigateToPage(target);
};

const runSearch = (keyword: string, isDesktop: boolean): void => {
	if (!keyword.trim()) {
		setPanelVisibility(false, isDesktop);
		result = [];
		return;
	}
	isSearching = true;
	clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		const posts = searchPosts(index, keyword);
		result = posts.slice(0, 5).map((p) => ({
			url: p.url,
			titleHtml: highlight(p.title, keyword),
			snippetHtml: buildSnippet(p.content, keyword),
		}));
		isSearching = false;
		setPanelVisibility(true, isDesktop);
	}, 300);
};

onMount(async () => {
	index = await loadSearchIndex();
	initialized = true;
	if (keywordDesktop) runSearch(keywordDesktop, true);
	if (keywordMobile) runSearch(keywordMobile, false);
});

$: if (initialized) runSearch(keywordDesktop, true);
$: if (initialized) runSearch(keywordMobile, false);
</script>

<!-- 桌面端搜索框 -->
<div class="panel-search-container relative hidden xl:flex">
	<div class="relative">
		<input
			type="text"
			class="w-40 rounded-full border-0 bg-(--card-divider) py-1.5 pl-9 pr-3 text-sm text-(--text) transition-all duration-200 hover:w-52 focus:w-60 focus:outline-none focus:ring-2 focus:ring-(--primary)"
			placeholder={i18n(I18nKey.search)}
			bind:value={keywordDesktop}
		/>
		<Icon
			class="absolute left-3 top-1/2 -translate-y-1/2 text-(--text-muted)"
			icon="fa-solid fa-search"
			size="0.9rem"
		/>
	</div>
</div>

<!-- 移动端搜索按钮 -->
<button
	class="xl:hidden cursor-pointer"
	aria-label="搜索"
	on:click={() => {
		const panel = document.getElementById("search-panel");
		if (panel?.classList.contains("float-panel-closed")) {
			panel.classList.remove("float-panel-closed");
			const input = document.getElementById(
				"mobile-search-input",
			) as HTMLInputElement | null;
			input?.focus();
		} else {
			panel?.classList.add("float-panel-closed");
		}
	}}
>
	<Icon icon="fa-solid fa-search" size="1.1rem" />
</button>

<div
	id="search-panel"
	class="float-panel-closed fixed left-1/2 top-24 z-50 max-h-[70vh] w-[90vw] max-w-[600px] -translate-x-1/2 overflow-y-auto rounded-2xl border border-(--card-border) bg-(--card-bg) p-4 shadow-2xl"
>
	<!-- 移动端搜索输入 -->
	<div class="relative mb-3 xl:hidden">
		<input
			id="mobile-search-input"
			type="text"
			class="w-full rounded-full border-0 bg-(--card-divider) py-2 pl-9 pr-3 text-sm text-(--text) focus:outline-none focus:ring-2 focus:ring-(--primary)"
			placeholder={i18n(I18nKey.search)}
			bind:value={keywordMobile}
		/>
		<Icon
			class="absolute left-3 top-1/2 -translate-y-1/2 text-(--text-muted)"
			icon="fa-solid fa-search"
			size="0.9rem"
		/>
	</div>

	{#if isSearching}
		<div class="px-2 py-6 text-center text-sm text-(--text-muted)">
			{i18n(I18nKey.searchLoading)}
		</div>
	{:else if result.length > 0}
		{#each result as item}
			<a
				href={item.url}
				on:click={(e) => handleResultClick(e, item.url)}
				class="flex flex-col gap-1 rounded-xl px-3 py-3 transition-colors hover:bg-(--card-divider)"
			>
				<div
					class="flex items-center gap-2 font-bold text-(--text) group-hover:text-(--primary)"
				>
					{@html item.titleHtml}
					<Icon
						class="text-(--text-muted)"
						icon="fa-solid fa-arrow-right"
						size="0.8rem"
					/>
				</div>
				{#if item.snippetHtml.includes("<mark>")}
					<div
						class="line-clamp-2 text-sm text-(--text-muted)"
					>
						{@html item.snippetHtml}
					</div>
				{/if}
			</a>
		{/each}
		{#if result.length > 5}
			<a
				href={getSearchUrl(keywordDesktop || keywordMobile)}
				on:click={(e) => {
					e.preventDefault();
					closeSearchPanel();
					navigateToPage(getSearchUrl(keywordDesktop || keywordMobile));
				}}
				class="block px-3 pt-2 text-center text-sm text-(--primary) hover:underline"
			>
				{i18n(I18nKey.searchViewMore).replace(
					"{count}",
					String(result.length - 5),
				)}
			</a>
		{/if}
	{:else if keywordDesktop || keywordMobile}
		<div class="px-2 py-6 text-center text-sm text-(--text-muted)">
			{i18n(I18nKey.searchNoResults)}
		</div>
	{:else}
		<div class="px-2 py-6 text-center text-sm text-(--text-muted)">
			{i18n(I18nKey.searchTypeSomething)}
		</div>
	{/if}
</div>
