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

let keyword = "";
let result: { url: string; titleHtml: string; snippetHtml: string }[] = [];
let total = 0;
let isSearching = false;
let index: SearchPost[] = [];
let panelOpen = false;
let desktopContainer: HTMLDivElement | undefined;
let mobileContainer: HTMLDivElement | undefined;
let debounceTimer: ReturnType<typeof setTimeout>;

const viewMoreLabel = (): string =>
	i18n(I18nKey.searchViewMore).replace(/\s*[（(]\{count\}[^）)]*[）)]/, "");

const runSearch = (kw: string): void => {
	if (!kw.trim()) {
		result = [];
		panelOpen = false;
		return;
	}
	panelOpen = true;
	isSearching = true;
	clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		const posts = searchPosts(index, kw);
		total = posts.length;
		result = posts.slice(0, 5).map((p) => ({
			url: p.url,
			titleHtml: highlight(p.title, kw),
			snippetHtml: buildSnippet(p.description + "\n" + p.content, kw),
		}));
		isSearching = false;
	}, 250);
};

const closePanel = (): void => {
	panelOpen = false;
	keyword = "";
	result = [];
};

let focused = false;

const onFocus = (): void => {
	focused = true;
	if (keyword.trim()) runSearch(keyword);
};

const onBlur = (): void => {
	focused = false;
	setTimeout(() => {
		if (!focused) panelOpen = false;
	}, 150);
};

const openMobilePanel = (): void => {
	panelOpen = true;
};

const handleResultClick = (event: Event, target: string): void => {
	event.preventDefault();
	closePanel();
	navigateToPage(target);
};

const goToSearchPage = (event: Event): void => {
	event.preventDefault();
	const q = keyword;
	closePanel();
	navigateToPage(getSearchUrl(q));
};

onMount(async () => {
	index = await loadSearchIndex();
	const onDocClick = (e: MouseEvent): void => {
		if (
			!desktopContainer?.contains(e.target as Node) &&
			!mobileContainer?.contains(e.target as Node)
		) {
			panelOpen = false;
		}
	};
	document.addEventListener("click", onDocClick);
	return () => document.removeEventListener("click", onDocClick);
});
</script>

<!-- 桌面端：搜索框即输入框，点击直接进入输入；聚焦时宽度由 4:1 拉伸到 6:1 -->
<div class="relative hidden md:block" bind:this={desktopContainer}>
	<div
		class="flex items-center rounded-lg bg-zinc-500/30 transition-all duration-300 ease-out {focused
			? 'w-72'
			: 'w-44'}"
	>
		<Icon icon="material-symbols:search" class="ml-3 shrink-0 text-white/80 text-base" />
		<input
			type="text"
			class="w-full bg-transparent py-2.5 pl-3 pr-3 text-sm text-white outline-none placeholder:text-white/70"
			placeholder={i18n(I18nKey.search) + "…"}
			bind:value={keyword}
			on:focus={onFocus}
			on:blur={onBlur}
			on:input={(e) => runSearch((e.currentTarget as HTMLInputElement).value)}
		/>
	</div>

	{#if panelOpen}
		<div class="search-panel absolute right-0 top-full z-50 mt-2 w-[22rem] max-h-[70vh] overflow-y-auto rounded-xl border border-white/10 bg-black/50 p-3 shadow-2xl backdrop-blur-md">
			{#if isSearching}
				<div class="px-2 py-6 text-center text-sm text-white/60">
					{i18n(I18nKey.searchLoading)}
				</div>
			{:else if result.length > 0}
				{#each result as item}
					<a
						href={item.url}
						on:click={(e) => handleResultClick(e, item.url)}
						class="flex flex-col gap-1 rounded-xl px-3 py-3 transition-colors hover:bg-white/10"
					>
						<div class="search-result-title flex items-center gap-1.5 text-base font-bold">
							<span>{@html item.titleHtml}</span>
							<Icon icon="fa7-solid:arrow-right" class="shrink-0" />
						</div>
						<div class="line-clamp-2 text-sm text-white/60">{@html item.snippetHtml}</div>
					</a>
				{/each}
				{#if total > 5}
					<a
						href={getSearchUrl(keyword)}
						on:click={goToSearchPage}
						class="block px-3 pt-2 text-center text-sm text-(--primary) hover:underline"
					>
						{viewMoreLabel()}
					</a>
				{/if}
			{:else if keyword.trim()}
				<div class="search-no-results px-2 py-6 text-center">
					{i18n(I18nKey.searchNoResults)}
				</div>
			{:else}
				<div class="px-2 py-6 text-center text-sm text-white/60">
					{i18n(I18nKey.searchTypeSomething)}
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- 移动端：与导航栏按钮一致 -->
<div class="md:hidden" bind:this={mobileContainer}>
	<button
		class="flex items-center gap-1.5 rounded-full bg-zinc-500 px-2.5 h-9 transition active:scale-95 hover:bg-zinc-600"
		aria-label={i18n(I18nKey.search)}
		on:click={openMobilePanel}
	>
		<Icon icon="material-symbols:search" class="text-white" />
		<span class="text-sm font-medium text-white">{i18n(I18nKey.search)}</span>
	</button>

	{#if panelOpen}
		<div
			class="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 px-4 pt-24"
			on:click={(e) => {
				if (e.target === e.currentTarget) closePanel();
			}}
			role="presentation"
		>
			<div class="search-panel w-full max-w-[600px] rounded-2xl border border-white/10 bg-black/60 p-4 shadow-2xl backdrop-blur-md">
				<div class="relative mb-3">
					<input
						type="text"
						autofocus
						class="w-full rounded-lg border border-white/10 bg-white/10 py-2 pl-9 pr-10 text-sm text-white outline-none placeholder:text-white/60 focus:border-(--primary)"
						placeholder={i18n(I18nKey.search) + "…"}
						bind:value={keyword}
						on:input={(e) => runSearch((e.currentTarget as HTMLInputElement).value)}
					/>
					<Icon class="absolute left-3 top-1/2 -translate-y-1/2 text-white/70" icon="material-symbols:search" />
					<button
						class="absolute right-3 top-1/2 -translate-y-1/2 text-white/70 hover:text-white"
						on:click={closePanel}
						aria-label="关闭"
					>
						✕
					</button>
				</div>
				{#if isSearching}
					<div class="px-2 py-6 text-center text-sm text-white/60">
						{i18n(I18nKey.searchLoading)}
					</div>
				{:else if result.length > 0}
					<div class="max-h-[50vh] overflow-y-auto">
						{#each result as item}
							<a
								href={item.url}
								on:click={(e) => handleResultClick(e, item.url)}
								class="flex flex-col gap-1 rounded-xl px-3 py-3 transition-colors hover:bg-white/10"
							>
								<div class="search-result-title flex items-center gap-1.5 text-base font-bold">
									<span>{@html item.titleHtml}</span>
									<Icon icon="fa7-solid:arrow-right" class="shrink-0" />
								</div>
								<div class="line-clamp-2 text-sm text-white/60">{@html item.snippetHtml}</div>
							</a>
						{/each}
					</div>
					<a
						href={getSearchUrl(keyword)}
						on:click={goToSearchPage}
						class="block px-3 pt-2 text-center text-sm text-(--primary) hover:underline"
					>
						{viewMoreLabel()}
					</a>
				{:else if keyword.trim()}
					<div class="search-no-results px-2 py-6 text-center">
						{i18n(I18nKey.searchNoResults)}
					</div>
				{:else}
					<div class="px-2 py-6 text-center text-sm text-white/60">
						{i18n(I18nKey.searchTypeSomething)}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
