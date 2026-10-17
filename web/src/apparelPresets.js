/**
 * 服装外贸专家预设：术语 / 邮件模板 / 阶段检查清单
 * （与 server/glossary、classify 互补，供设置页与 DealBar 使用）
 */

export const APPAREL_GLOSSARY_EXTRA = [
  { src: 'Tech pack', dst: '工艺单 / 技术包' },
  { src: 'BOM', dst: '物料清单' },
  { src: 'GSM', dst: '克重（克/平方米）' },
  { src: 'Composition', dst: '成分' },
  { src: 'Colorway', dst: '配色' },
  { src: 'Size run', dst: '尺码配比' },
  { src: 'Grading', dst: '放码' },
  { src: 'Fit sample', dst: '试穿样 / 合体样' },
  { src: 'Size set', dst: '全码样' },
  { src: 'Strike off', dst: '印花确认样' },
  { src: 'Trim', dst: '辅料' },
  { src: 'AQL', dst: '可接受质量水平（抽检）' },
  { src: 'Carton', dst: '外箱' },
  { src: 'Assortment', dst: '配码 / 配色装箱' },
  { src: 'HTS', dst: '海关税则号' },
  { src: 'C/O', dst: '原产地证' },
];

/** 服装外贸常用邮件模板（设置 → 一键导入） */
export const APPAREL_EMAIL_TEMPLATES = [
  {
    name: '询盘确认 + 要规格',
    subject: 'Re: Your inquiry — specs & MOQ',
    body: `Hi {{name}},

Thank you for your inquiry. To prepare an accurate quotation, could you please confirm:

1) Style / reference photos or tech pack
2) Fabric composition & GSM (or fabric code)
3) Colors / colorways and target quantity per color
4) Size run and destination market
5) Target price / Incoterms (FOB / CIF…) and ship window

We can also recommend fabric and trims based on your end use.

Best regards`,
  },
  {
    name: '报价跟进',
    subject: 'Following up on our quotation',
    body: `Hi {{name}},

Just checking in on the quotation we sent. Does the pricing and lead time work for you?

If anything needs adjusting (MOQ, fabric, packing, or ship date), tell me and I will revise promptly.

Best regards`,
  },
  {
    name: '样品寄出通知',
    subject: 'Sample shipped — tracking enclosed',
    body: `Hi {{name}},

Your sample has been shipped. Tracking: [tracking number / courier].

Please review fit, fabric hand-feel, and workmanship. Share comments anytime — we can revise before bulk.

Best regards`,
  },
  {
    name: '样品修改确认',
    subject: 'Sample comments received — revision plan',
    body: `Hi {{name}},

Thank you for the fit / quality comments. We will revise as follows:

- [point 1]
- [point 2]

Updated sample ETA: [date]. Please confirm if anything else should be included.

Best regards`,
  },
  {
    name: '大货细节锁定',
    subject: 'Bulk order checklist — please confirm',
    body: `Hi {{name}},

To lock production, please confirm:

1) Final quantities by color / size
2) Approved sample / lab dips / strike-offs
3) Packing (assortment, polybag, carton marks)
4) Delivery date and shipping mode
5) Payment terms / PI reference

Once confirmed we will issue PI and book the line.

Best regards`,
  },
  {
    name: 'PI / 定金提醒',
    subject: 'PI & deposit — ready when you are',
    body: `Hi {{name}},

Please find the proforma invoice attached / previously sent. Production starts after the deposit is confirmed.

Let me know if you need any banking documents or adjustments on the PI.

Best regards`,
  },
  {
    name: '出货文件齐全',
    subject: 'Shipment docs — BL / packing list / invoice',
    body: `Hi {{name}},

Shipment is on track. We will share commercial invoice, packing list, and B/L (or AWB) as soon as available.

Please advise if you need C/O, test reports, or other documents for customs clearance.

Best regards`,
  },
  {
    name: '开发信 · OEM 成衣',
    subject: 'OEM apparel partnership — [your category]',
    body: `Hi {{name}},

We are an apparel manufacturer specializing in [category, e.g. activewear / knitwear]. We support OEM/ODM with:

- Flexible MOQ for first orders
- Fabric sourcing + lab dips
- Fit samples → PP sample → bulk with AQL QC
- FOB / CIF options and on-time shipping

If you have upcoming styles or tech packs, I would be glad to quote.

Best regards`,
  },
];

/** 读信 DealBar：当前阶段该核对什么（服装链路） */
export const STAGE_CHECKLIST = {
  inquiry: '核对：用途 / 面料成分克重 / 颜色尺码 / 目标价与贸易术语 / 交期窗口',
  quote: '核对：单价与币种 / MOQ / 交期 / 付款条件 / 是否含辅料运费',
  sample: '核对：样品类型(SMS/Fit/PP) / 快递单号 / 修改意见 / 大货意向数量',
  bulk: '核对：PO 数量配码 / 批准样 / 包装唛头 / 船期 / 是否已出 PI',
  payment: '核对：PI 金额 / 定金比例与水单 / 尾款节点 / 能否下线生产',
  won: '核对：出货文件 / 验货 / 是否有返单或下一季开发',
  lost: '可轻问原因；保留联系，勿强推报价',
};

export function stageChecklist(stage) {
  return STAGE_CHECKLIST[stage] || '';
}
