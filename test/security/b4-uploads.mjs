// Phase B4 — uploads and object storage. Local only.
//
// The local test API has no S3 credentials on purpose (nothing leaves the
// machine), so the storage layer is exercised in-process: the real compiled
// StorageProvider with its S3 client swapped for a recorder. The HTTP checks
// cover what happens before storage (who may upload where, which URLs pass).
import path from "node:path";
import { createRequire } from "node:module";
import { api, login, phoneSignIn, data, check, section, done, said } from "./lib.mjs";

section("who may upload where (HTTP)");
{
  const C = (await login("customer@shapthagiri-edibles.com", "customer")).accessToken;
  const fd = () => { const f = new FormData(); f.append("file", new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" }), "x.png"); return f; };
  for (const folder of ["products", "documents", "categories", "general"]) {
    const r = await api("POST", `/uploads?folder=${folder}`, { token: C, body: fd() });
    check(`customer cannot upload into ${folder}/`, r.status === 403, said(r));
  }
  const ok = await api("POST", "/uploads?folder=reviews", { token: C, body: fd() });
  check("regression: customer upload to reviews/ passes the folder check (storage itself is off locally)", ok.status !== 403, said(ok));

  const js = await api("POST", "/uploads?folder=avatars", { token: C, body: { url: "javascript:alert(document.cookie)" } });
  check("URL alternative refuses javascript:", js.status === 400, said(js));
  const plain = await api("POST", "/uploads?folder=avatars", { token: C, body: { url: "http://169.254.169.254/latest/meta-data/" } });
  check("URL alternative refuses plain-http / internal addresses", plain.status === 400, said(plain));
}

section("invoice record");
{
  const C = (await login("customer@shapthagiri-edibles.com", "customer")).accessToken;
  const { q } = await import("./lib.mjs");
  // The first of the customer's orders that can be invoiced (unpaid ones are
  // refused by design; earlier suites change the sample order's state).
  const orders = await q(`select o.id from orders o join users u on u.id = o."userId" where u.email = 'customer@shapthagiri-edibles.com' order by o."createdAt"`);
  let r;
  for (const o of orders) { r = await api("GET", `/orders/me/${o.id}/invoice.pdf`, { token: C }); if (r.status === 200) break; }
  if (r?.status !== 200) {
    const [paid] = await q(`update orders set "paymentStatus" = 'captured' where id = $1 returning id`, [orders[0].id]);
    r = await api("GET", `/orders/me/${paid.id}/invoice.pdf`, { token: C });
  }
  const rec = data(r) ?? {};
  check("the invoice record a customer receives carries no storage URL", r.status === 200 && !("url" in rec) && !!rec.number, `${said(r)} keys=${Object.keys(rec).join(",")}`);
}

section("what gets stored (in-process, recorder in place of S3)");
// Configure a bucket for this process only, before the compiled modules load.
process.env.AWS_ACCESS_KEY_ID = "test"; process.env.AWS_SECRET_ACCESS_KEY = "test";
process.env.AWS_REGION = "us-east-1"; process.env.AWS_S3_BUCKET = "verify-bucket";
process.env.DOTENV_CONFIG_PATH = path.resolve(".env.localtest");
const fromDist = createRequire(path.resolve("dist/main.js"));
const { StorageProvider, isOwnMediaUrl } = fromDist("./common/providers/storage.provider");
const p = new StorageProvider();
const sent = [];
p.s3Client = { send: async (cmd) => { sent.push({ name: cmd.constructor.name, ...cmd.input }); return {}; } };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const box = (brand) => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftyp" + brand, "latin1"), Buffer.alloc(32)]);
const HTML = Buffer.from("<html><script>alert(1)</script></html>");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');

{
  const url = await p.saveBuffer(PNG, "invoice.pdf", "products");
  const put = sent.at(-1);
  check("a PNG named .pdf is stored as image/png with a .png key (extension lies, bytes win)",
    put?.ContentType === "image/png" && /^products\/[0-9a-f-]+\.png$/.test(put?.Key ?? ""), `${put?.ContentType} ${put?.Key}`);
  for (const [label, buf] of [["HTML", HTML], ["SVG", SVG], ["AVIF (ISO-BMFF, brand avif)", box("avif")], ["HEIC (brand heic)", box("heic")]]) {
    let refused = false;
    try { await p.saveBuffer(buf, "x.png", "products"); } catch { refused = true; }
    check(`${label} is refused, whatever its name`, refused);
  }
  await p.saveBuffer(box("isom"), "clip.bin", "reviews");
  check("a real MP4 (brand isom) is still accepted as video/mp4", sent.at(-1)?.ContentType === "video/mp4", sent.at(-1)?.ContentType);
}

{
  const own = "https://verify-bucket.s3.us-east-1.amazonaws.com";
  const before = sent.length;
  await p.deleteFile("https://other-bucket.s3.us-east-1.amazonaws.com/products/x.png");
  await p.deleteFile(`${own}/invoices/INV-1.pdf`);
  await p.deleteFile(`${own}/../invoices/INV-1.pdf`);
  check("delete ignores another bucket's URL and our invoices/ prefix", sent.length === before, `${sent.length - before} delete(s) sent`);
  await p.deleteFile(`${own}/products/abc.png`);
  check("regression: deleting our own product image still works", sent.at(-1)?.name === "DeleteObjectCommand" && sent.at(-1)?.Key === "products/abc.png");

  check("own media URL recognised", isOwnMediaUrl(`${own}/products/a.png`));
  check("foreign https URL rejected", !isOwnMediaUrl("https://evil.example/a.png"));
  check("http URL of our host rejected", !isOwnMediaUrl(`http://verify-bucket.s3.us-east-1.amazonaws.com/a.png`));
}

await done();
process.exit(process.exitCode ?? 0);
