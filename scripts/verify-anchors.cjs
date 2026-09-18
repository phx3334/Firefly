const fs = require("node:fs");
const posts = JSON.parse(fs.readFileSync("dist/api/search.json", "utf8"));
let totalHit = 0;
let totalMiss = 0;
const missDetails = [];
for (const post of posts) {
	let html;
	try {
		html = fs.readFileSync(`dist${post.url}index.html`, "utf8");
	} catch {
		console.log("!! html missing:", post.url);
		continue;
	}
	for (const b of post.blocks ?? []) {
		if (html.includes(`id="${b.id}"`)) {
			totalHit++;
		} else {
			totalMiss++;
			if (missDetails.length < 5) missDetails.push({ url: post.url, id: b.id });
		}
	}
}
console.log("posts checked:", posts.length);
console.log("anchor total match:", totalHit, "miss:", totalMiss);
if (missDetails.length) console.log(JSON.stringify(missDetails, null, 1));
