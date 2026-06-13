/** Small vector helpers shared by voiceprint enrollment + matching. */

export function l2(v: number[]): number {
	let s = 0;
	for (const x of v) s += x * x;
	return Math.sqrt(s);
}

/** Cosine similarity; -1 on dimension mismatch / empty. */
export function cosine(a: number[], b: number[]): number {
	if (a.length !== b.length || a.length === 0) return -1;
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
	const n = l2(a) * l2(b);
	return n > 0 ? dot / n : -1;
}

/** L2-normalized mean of a set of equal-length vectors. */
export function meanNorm(vs: number[][]): number[] {
	const first = vs[0];
	if (!first) return [];
	const dim = first.length;
	const acc = new Array<number>(dim).fill(0);
	for (const v of vs) {
		if (v.length !== dim) continue;
		for (let i = 0; i < dim; i++) acc[i]! += v[i]!;
	}
	const n = l2(acc);
	return n > 0 ? acc.map(x => x / n) : acc;
}
