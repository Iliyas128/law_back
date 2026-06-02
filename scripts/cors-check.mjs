const base = process.argv[2] ?? "https://law-back1.vercel.app";
const origin = process.argv[3] ?? "https://www.snowtech.asia";

const urls = [`${base}/api/health`, `${base}/api/chat`];

for (const url of urls) {
  console.log(`\n=== OPTIONS ${url} ===`);
  const res = await fetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  console.log("status:", res.status);
  console.log("acao:", res.headers.get("access-control-allow-origin"));
  console.log("body:", (await res.text()).slice(0, 200));
}

console.log(`\n=== GET ${base}/api/health ===`);
const health = await fetch(`${base}/api/health`, { headers: { Origin: origin } });
console.log("status:", health.status);
console.log("acao:", health.headers.get("access-control-allow-origin"));
console.log("body:", (await health.text()).slice(0, 300));
