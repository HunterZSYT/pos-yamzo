const YAMZO_REPORT_CONFIG = Object.freeze({
  ordersTab: __YAMZO_ORDERS_TAB_JSON__,
  orderItemsTab: __YAMZO_ORDER_ITEMS_TAB_JSON__,
  costsTab: __YAMZO_COSTS_TAB_JSON__
});

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Yamzo Reports')
    .addItem('Download detailed PDF', 'showYamzoReportDialog')
    .addToUi();
}

function showYamzoReportDialog() {
  const output = HtmlService.createHtmlOutputFromFile('ReportDialog')
    .setWidth(560)
    .setHeight(610);
  SpreadsheetApp.getUi().showModalDialog(output, 'Yamzo report');
}

function getYamzoReportDefaults() {
  const timezone = Session.getScriptTimeZone() || 'Asia/Dhaka';
  const today = Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd');
  return { today: today, timezone: timezone };
}

function generateYamzoReportPdf(request) {
  const range = resolveYamzoRange_(request || {});
  const orders = readYamzoObjects_(YAMZO_REPORT_CONFIG.ordersTab)
    .filter(function (row) { return inYamzoRange_(row['Order Date'], range); });
  const orderIds = {};
  orders.forEach(function (order) { orderIds[String(order['POS Order ID'])] = true; });
  const orderItems = readYamzoObjects_(YAMZO_REPORT_CONFIG.orderItemsTab)
    .filter(function (row) { return Boolean(orderIds[String(row['POS Order ID'])]); });
  const costs = readYamzoObjects_(YAMZO_REPORT_CONFIG.costsTab)
    .filter(function (row) { return inYamzoRange_(row['Cost Date'], range); });

  const pdf = buildYamzoPdf_(orders, orderItems, costs, range);
  return {
    filename: 'Yamzo-Detailed-Report-' + range.start + '-to-' + range.end + '.pdf',
    mimeType: MimeType.PDF,
    base64: Utilities.base64Encode(pdf.getBytes()),
    orderCount: orders.length,
    settledOrderCount: orders.filter(function (order) { return String(order.Status).toLowerCase() === 'settled'; }).length,
    costCount: costs.length
  };
}

function resolveYamzoRange_(request) {
  const timezone = Session.getScriptTimeZone() || 'Asia/Dhaka';
  const now = new Date();
  const end = dateKey_(now, timezone);
  const preset = String(request.preset || 'today');
  if (preset === 'custom') {
    const customStart = normalizeDateKey_(request.startDate);
    const customEnd = normalizeDateKey_(request.endDate);
    if (!customStart || !customEnd) throw new Error('Choose both custom dates.');
    if (customStart > customEnd) throw new Error('Start date must be on or before end date.');
    return { start: customStart, end: customEnd, label: customStart + ' to ' + customEnd };
  }
  const daysBack = preset === 'yesterday' ? 1 : preset === '7days' ? 6 : preset === '30days' ? 29 : 0;
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
  const rangeEnd = preset === 'yesterday'
    ? dateKey_(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1), timezone)
    : end;
  const start = preset === 'yesterday' ? rangeEnd : dateKey_(startDate, timezone);
  return { start: start, end: rangeEnd, label: start === rangeEnd ? start : start + ' to ' + rangeEnd };
}

function buildYamzoPdf_(orders, items, costs, range) {
  const settledOrders = orders.filter(function (order) { return String(order.Status).toLowerCase() === 'settled'; });
  const settledOrderIds = {};
  settledOrders.forEach(function (order) { settledOrderIds[String(order['POS Order ID'])] = true; });
  const soldItems = items.filter(function (item) {
    return Boolean(settledOrderIds[String(item['POS Order ID'])]) && String(item.Status).toLowerCase() !== 'voided';
  });
  const document = DocumentApp.create('Yamzo report ' + range.label);
  const body = document.getBody();
  body.setMarginTop(32).setMarginBottom(32).setMarginLeft(34).setMarginRight(34);

  const title = body.appendParagraph('YAMZO  |  DETAILED OPERATIONS REPORT');
  title.setHeading(DocumentApp.ParagraphHeading.TITLE).setForegroundColor('#12372A');
  body.appendParagraph(range.label + '  -  Generated ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMM yyyy, hh:mm a'))
    .setForegroundColor('#52635B');
  body.appendHorizontalRule();

  const gross = sumYamzo_(settledOrders, 'Subtotal');
  const discounts = sumYamzo_(settledOrders, 'Discount');
  const netSales = sumYamzo_(settledOrders, 'Total');
  const paid = sumYamzo_(settledOrders, 'Paid Amount');
  const costTotal = sumYamzo_(costs, 'Amount');
  const openCount = orders.filter(function (order) {
    const status = String(order.Status).toLowerCase();
    return status !== 'settled' && status !== 'cancelled';
  }).length;
  const cancelledCount = orders.filter(function (order) { return String(order.Status).toLowerCase() === 'cancelled'; }).length;
  appendYamzoSection_(body, 'At a glance');
  appendYamzoTable_(body, [
    ['Completed orders', String(settledOrders.length), 'Gross sales', moneyYamzo_(gross)],
    ['Open / cancelled', String(openCount) + ' / ' + String(cancelledCount), 'Discounts', moneyYamzo_(discounts)],
    ['Net sales', moneyYamzo_(netSales), 'Paid amount', moneyYamzo_(paid)],
    ['Tracked costs', moneyYamzo_(costTotal), 'Sales less costs', moneyYamzo_(netSales - costTotal)],
    ['Items sold', String(sumYamzo_(soldItems, 'Quantity')), 'All order records', String(orders.length)]
  ], false);

  appendYamzoSection_(body, 'Sales by source');
  appendYamzoTable_(body, aggregateYamzo_(settledOrders, 'Source', 'Total', 'Orders'), true);

  appendYamzoSection_(body, 'Payments');
  appendYamzoTable_(body, paymentYamzoRows_(settledOrders), true);

  appendYamzoSection_(body, 'Order detail');
  const itemsByOrder = {};
  items.forEach(function (item) {
    if (String(item.Status).toLowerCase() === 'voided') return;
    const id = String(item['POS Order ID']);
    if (!itemsByOrder[id]) itemsByOrder[id] = [];
    itemsByOrder[id].push(String(item['Item Name']) + ' x ' + String(item.Quantity));
  });
  const orderRows = [['Date', 'Order', 'Source', 'Status', 'Items', 'Total', 'Payment']];
  orders.forEach(function (order) {
    orderRows.push([
      normalizeDateKey_(order['Order Date']) || '',
      String(order['Order Number'] || ''),
      String(order.Source || ''),
      titleYamzo_(order.Status),
      (itemsByOrder[String(order['POS Order ID'])] || []).join(', '),
      moneyYamzo_(numberYamzo_(order.Total)),
      String(order['Payment Methods'] || '')
    ]);
  });
  appendYamzoTable_(body, orderRows, true);

  appendYamzoSection_(body, 'Item performance');
  appendYamzoTable_(body, itemYamzoRows_(soldItems), true);

  appendYamzoSection_(body, 'Costs');
  const costRows = [['Date', 'Category', 'Cost', 'Payment', 'Responsible', 'Amount']];
  costs.forEach(function (cost) {
    costRows.push([
      normalizeDateKey_(cost['Cost Date']) || '',
      String(cost.Category || 'Uncategorized'),
      String(cost['Cost Name'] || ''),
      String(cost['Payment Method'] || ''),
      String(cost['Responsible Person'] || ''),
      moneyYamzo_(numberYamzo_(cost.Amount))
    ]);
  });
  if (costRows.length === 1) costRows.push(['-', 'No costs in this range', '', '', '', moneyYamzo_(0)]);
  appendYamzoTable_(body, costRows, true);

  body.appendParagraph('Generated from the Yamzo POS source-of-truth export. Sheet edits are not imported into POS.')
    .setForegroundColor('#718078').setFontSize(8).setSpacingBefore(16);
  document.saveAndClose();
  const file = DriveApp.getFileById(document.getId());
  const pdf = file.getAs(MimeType.PDF).setName('Yamzo report.pdf');
  file.setTrashed(true);
  return pdf;
}

function readYamzoObjects_(sheetName) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
  const headers = values.shift().map(function (header) { return String(header).trim(); });
  return values.map(function (row) {
    const value = {};
    headers.forEach(function (header, index) { value[header] = row[index]; });
    return value;
  }).filter(function (row) { return Object.keys(row).some(function (key) { return row[key] !== '' && row[key] !== null; }); });
}

function aggregateYamzo_(rows, labelKey, amountKey, countLabel) {
  const buckets = {};
  rows.forEach(function (row) {
    const label = String(row[labelKey] || 'Unspecified');
    if (!buckets[label]) buckets[label] = { count: 0, amount: 0 };
    buckets[label].count += 1;
    buckets[label].amount += numberYamzo_(row[amountKey]);
  });
  const output = [[labelKey, countLabel, 'Amount']];
  Object.keys(buckets).sort().forEach(function (label) {
    output.push([label, String(buckets[label].count), moneyYamzo_(buckets[label].amount)]);
  });
  if (output.length === 1) output.push(['No data', '0', moneyYamzo_(0)]);
  return output;
}

function paymentYamzoRows_(orders) {
  const totals = {};
  orders.forEach(function (order) {
    const text = String(order['Payment Methods'] || '').trim();
    if (!text) return;
    text.split(',').forEach(function (part) {
      const match = part.trim().match(/^(.+?):\s*(-?[\d.]+)$/);
      if (!match) return;
      const method = titleYamzo_(match[1]);
      totals[method] = (totals[method] || 0) + numberYamzo_(match[2]);
    });
  });
  const output = [['Method', 'Amount']];
  Object.keys(totals).sort().forEach(function (method) { output.push([method, moneyYamzo_(totals[method])]); });
  if (output.length === 1) output.push(['No payments', moneyYamzo_(0)]);
  return output;
}

function itemYamzoRows_(items) {
  const totals = {};
  items.forEach(function (item) {
    if (String(item.Status).toLowerCase() === 'voided') return;
    const name = String(item['Item Name'] || 'Unnamed item');
    if (!totals[name]) totals[name] = { quantity: 0, amount: 0 };
    totals[name].quantity += numberYamzo_(item.Quantity);
    totals[name].amount += numberYamzo_(item['Line Total']);
  });
  const output = [['Item', 'Quantity', 'Sales']];
  Object.keys(totals).sort(function (a, b) { return totals[b].amount - totals[a].amount; }).forEach(function (name) {
    output.push([name, String(totals[name].quantity), moneyYamzo_(totals[name].amount)]);
  });
  if (output.length === 1) output.push(['No sold items', '0', moneyYamzo_(0)]);
  return output;
}

function appendYamzoSection_(body, text) {
  body.appendParagraph(text).setHeading(DocumentApp.ParagraphHeading.HEADING2)
    .setForegroundColor('#12372A').setSpacingBefore(14).setSpacingAfter(6);
}

function appendYamzoTable_(body, rows, header) {
  const safeRows = rows.length ? rows : [['No data']];
  const table = body.appendTable(safeRows);
  table.setBorderColor('#D7E0DA').setBorderWidth(0.5);
  if (header && table.getNumRows() > 0) {
    const first = table.getRow(0);
    for (let index = 0; index < first.getNumCells(); index += 1) {
      first.getCell(index).setBackgroundColor('#12372A');
      first.getCell(index).editAsText().setForegroundColor('#FFFFFF').setBold(true);
    }
  }
  for (let row = header ? 1 : 0; row < table.getNumRows(); row += 1) {
    if (row % 2 === (header ? 0 : 1)) {
      const current = table.getRow(row);
      for (let cell = 0; cell < current.getNumCells(); cell += 1) current.getCell(cell).setBackgroundColor('#F5F8F6');
    }
  }
  return table;
}

function inYamzoRange_(value, range) {
  const key = normalizeDateKey_(value);
  return Boolean(key && key >= range.start && key <= range.end);
}

function normalizeDateKey_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return dateKey_(value, Session.getScriptTimeZone());
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function dateKey_(date, timezone) {
  return Utilities.formatDate(date, timezone || Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function sumYamzo_(rows, key) {
  return rows.reduce(function (total, row) { return total + numberYamzo_(row[key]); }, 0);
}

function numberYamzo_(value) {
  const number = Number(value);
  return isFinite(number) ? number : 0;
}

function moneyYamzo_(value) {
  const rounded = Math.round(numberYamzo_(value) * 100) / 100;
  return 'BDT ' + rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function titleYamzo_(value) {
  return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, function (char) { return char.toUpperCase(); });
}
