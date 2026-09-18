import type { Root } from "hast";

export interface SearchBlockEntry {
	id: string;
	text: string;
	headingId: string | null;
}

export interface BlockAnchorsOptions {
	collect?: boolean;
}

export function assignBlockIds(tree: Root): Root;
export function collectBlocks(tree: Root): SearchBlockEntry[];
export default function rehypeBlockAnchors(
	options?: BlockAnchorsOptions,
): (tree: Root, file: { data: { blocks?: SearchBlockEntry[] } }) => void;
