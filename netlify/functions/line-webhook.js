// netlify/functions/line-webhook.js
module.exports.handler = async (event) => {
  try {
    // Log event ให้เราดู userId ได้ใน Netlify Logs
    console.log("LINE Webhook Event:", event.body);

    // ต้องตอบ 200 เสมอ ไม่งั้น Webhook จะ Verify ไม่ผ่าน
    return {
      statusCode: 200,
      body: "OK"
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 200,
      body: "OK" // ตอบ 200 เหมือนกัน
    };
  }
};
