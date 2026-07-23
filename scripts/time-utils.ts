/**
 * 统一时间接口：所有"创建时间"都通过这里生成。
 *
 * 设计原则（与用户约定）：
 * 1. 统一使用站点时区（siteConfig.timezone，默认 Asia/Shanghai / 北京时间）。
 * 2. 创建时间冻结在创建那一刻（调用时刻），不会随时间自增。
 * 3. 对外产出的是"绝对 UTC 毫秒 / 带偏移的 ISO 字符串"，
 *    这样无论构建机/访客机器是什么时区，显示出来都是正确的站点时区时间。
 */
import { siteConfig } from "../src/config/siteConfig.ts";

const TZ = siteConfig.timezone || "Asia/Shanghai";

type Parts = {
	year: string;
	month: string;
	day: string;
	hour: string;
	minute: string;
	second: string;
};

// 返回某瞬间在站点时区下的"墙钟"字段，默认冻结于调用时刻
export function getLocalParts(date: Date = new Date()): Parts {
	const p = new Intl.DateTimeFormat("en-CA", {
		timeZone: TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const obj: Record<string, string> = {};
	for (const part of p) {
		if (part.type !== "literal") obj[part.type] = part.value;
	}
	return obj as Parts;
}

// 站点时区相对 UTC 的偏移毫秒（含夏令时）
function tzOffsetMs(date: Date): number {
	const p = new Intl.DateTimeFormat("en-US", {
		timeZone: TZ,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(date);
	const o: Record<string, string> = {};
	for (const part of p) {
		if (part.type !== "literal") o[part.type] = part.value;
	}
	const asUTC = Date.UTC(
		+o.year,
		+o.month - 1,
		+o.day,
		+o.hour,
		+o.minute,
		+o.second,
	);
	return asUTC - date.getTime();
}

// 把"站点时区墙钟时间"转成绝对 UTC 毫秒（用于冻结的创建时间）
export function localWallClockToUtcMs(
	y: number,
	mo: number,
	d: number,
	h: number,
	mi: number,
	s = 0,
): number {
	const asUTC = Date.UTC(y, mo - 1, d, h, mi, s);
	return asUTC - tzOffsetMs(new Date(asUTC));
}

// 当前真实时间（站点时区）的 UTC 毫秒，冻结在调用时刻
export function nowUtcMs(): number {
	const p = getLocalParts();
	return localWallClockToUtcMs(
		+p.year,
		+p.month,
		+p.day,
		+p.hour,
		+p.minute,
		+p.second,
	);
}

// 当前站点时区日期字符串 YYYY-MM-DD
export function todayString(): string {
	const p = getLocalParts();
	return `${p.year}-${p.month}-${p.day}`;
}

// 当前站点时区日期时间 ISO 字符串（带时区偏移），可直接写入文章 published
export function nowIsoString(): string {
	const p = getLocalParts();
	const offsetMin = Math.round(tzOffsetMs(new Date()) / 60000);
	const sign = offsetMin >= 0 ? "+" : "-";
	const abs = Math.abs(offsetMin);
	const oh = Math.floor(abs / 60);
	const om = abs % 60;
	const offset = `${sign}${String(oh).padStart(2, "0")}:${String(om).padStart(2, "0")}`;
	return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}
