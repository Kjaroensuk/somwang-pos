// netlify/functions/order-webhook.js
// ส่งข้อความเข้า LINE OA ทันที พร้อม Flex Message ฟอร์แมตบิล
// ใช้ env: LINE_TOKEN, LINE_TO, (ตัวเลือก) GCP_SA = Service Account JSON (ทั้งก้อน) เพื่อบันทึก Firestore

let admin;            // lazy require firebase-admin (เฉพาะเมื่อมี GCP_SA)
let appInitialized = false;

function getFirestore() {
  if (!process.env.GCP_SA) return null;
  if (!admin) {
    // ใช้ require เพื่อหลีกเลี่ยงปัญหา ESM/CJS
    admin = require("firebase-admin");
  }
  if (!appInitialized) {
    const sa = JSON.parse(process.env.GCP_SA);
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    appInitialized = true;
  }
  return admin.firestore();
}

function formatTHB(n) {
  return new Intl.NumberFormat("th-TH", { style: "currency", currency: "THB" })
    .format(Number(n) || 0);
}

function formatThaiDateTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleString("th-TH", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

// === Flex Message ===
// หัวบิล: ไก่ทอดสมหวัง
// บรรทัด 2: ช่องทางการขาย
// บรรทัด 3: Order ID
// ตาราง: รายการ | จำนวน | ราคา (บรรทัดละ qty*price)
// ท้ายบิล: รวมทั้งบิล + เวลาที่ขาย
function buildOrderFlex(orderId, order) {
  const channel = order.channel || "-";
  const soldAt  = formatThaiDateTime(order.paidAt);
  const items   = Array.isArray(order.items) ? order.items : [];

  const headerRow = {
    type: "box", layout: "horizontal",
    contents: [
      { type: "text", text: "รายการ", size: "sm", weight: "bold", flex: 5 },
      { type: "text", text: "จำนวน", size: "sm", weight: "bold", align: "center", flex: 2 },
      { type: "text", text: "ราคา",  size: "sm", weight: "bold", align: "end",   flex: 3 }
    ]
  };

  const rows = items.map(it => {
    const name = (it.name ?? "").toString().slice(0, 40) || "-";
    const qty  = Number(it.qty || 0);
    const line = (Number(it.price || 0) * qty);
    return {
      type: "box", layout: "horizontal", spacing: "sm",
      contents: [
        { type: "text", text: name, size: "sm", flex: 5, wrap: true },
        { type: "text", text: "x" + qty, size: "sm", flex: 2, align: "center" },
        { type: "text", text: formatTHB(line), size: "sm", flex: 3, align: "end" }
      ]
    };
  });

  const total = Number(order.total) || items.reduce((s, it) =>
    s + (Number(it.price || 0) * Number(it.qty || 0)), 0
  );

  return {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: "ไก่ทอดสมหวัง", weight: "bold", size: "lg", color: "#b91c1c" },
        { type: "text", text: `ช่องทาง: ${channel}`, size: "sm", color: "#6b7280" },
        { type: "text", text: `Order ID: ${orderId}`, size: "sm", color: "#6b7280" },
        // ถ้าต้องการโชว์สาขา เพิ่มบรรทัดนี้:
        ...(order.branch ? [{ type: "text", text: `สาขา: ${order.branch}`, size: "sm", color: "#6b7280" }] : []),

        { type: "separator", margin: "md" },

        headerRow,
        {
          type: "box", layout: "vertical", margin: "sm", spacing: "xs",
          contents: rows.length ? rows : [{ type: "text", text: "(ไม่มีรายการสินค้า)", size: "sm", color: "#9ca3af" }]
        },

        { type: "separator", margin: "md" },

        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: "รวมทั้งบิล", weight: "bold", flex: 5 },
            { type: "text", text: formatTHB(total), weight: "bold", align: "end", flex: 5 }
          ]
        },
        { type: "text", text: `เวลาที่ขาย: ${soldAt}`, size: "xs", color: "#6b7280" }
      ]
    }
  };
}

async function pushLineFlex({ to, orderId, order }) {
  const payload = {
    to,
    messages: [
      {
        type: "flex",
        altText: `Order ${orderId} | ${order.channel || "-"}`,
        contents: buildOrderFlex(orderId, order)
      }
    ]
  };

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + process.env.LINE_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  if (!res.ok) throw new Error(text || `LINE push error ${res.status}`);
}

module.exports.handler = async (event) => {
  // OPTIONS สำหรับ preflight CORS (กรณีเรียกจากหน้าเว็บ)
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    if (!process.env.LINE_TOKEN) throw new Error("Missing LINE_TOKEN");
    if (!process.env.LINE_TO) throw new Error("Missing LINE_TO");

    const body = JSON.parse(event.body || "{}");
    const { orderId, items = [], total, cashier, branch, channel, paidAt } = body;

    if (!orderId) throw new Error("Missing orderId");

    // (ออปชัน) บันทึก Firestore เพื่อทำรายงาน/ดูย้อนหลัง
    const db = getFirestore();
    if (db) {
      await db.collection("orders").doc(orderId).set({
        items,
        total: Number(total) || items.reduce((s, it) => s + (Number(it.price || 0) * Number(it.qty || 0)), 0),
        cashier: cashier || "-",
        branch: branch || "-",
        channel: channel || "-",
        paidAt: paidAt
          ? admin.firestore.Timestamp.fromDate(new Date(paidAt))
          : admin.firestore.FieldValue.serverTimestamp(),
        status: "PAID",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    // ส่ง Flex เข้า LINE OA
    await pushLineFlex({
      to: process.env.LINE_TO,
      orderId,
      order: { items, total, cashier, branch, channel, paidAt }
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: true })
    };
  } catch (e) {
    console.error("order-webhook error:", e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
};
