const SAMPLE_CSV = `Date,Description,Amount
2026-03-01,Payroll Deposit,2450.00
2026-03-02,Rent Payment,-1200.00
2026-03-03,Trader Joe's,-84.12
2026-03-04,Shell Oil,-41.33
2026-03-05,Netflix,-15.49
2026-03-06,Transfer to Savings,-300.00
2026-03-07,Electric Utility,-92.18
2026-03-08,Starbucks,-12.45
2026-03-10,Amazon Marketplace,-68.27
2026-03-11,Restaurant Charge,-47.85
2026-03-12,Venmo Cashout,120.00
2026-03-14,Employer Reimbursement,90.00`;

const CATEGORY_RULES = [
  { category: "Housing", keywords: ["rent", "mortgage", "property management", "apartment"] },
  { category: "Groceries", keywords: ["grocery", "trader joe", "whole foods", "aldi", "kroger", "walmart", "costco", "target"] },
  { category: "Dining", keywords: ["restaurant", "coffee", "starbucks", "chipotle", "uber eats", "doordash", "grubhub", "mcdonald"] },
  { category: "Transportation", keywords: ["shell", "chevron", "exxon", "uber", "lyft", "parking", "gas", "fuel", "metro"] },
  { category: "Bills & Utilities", keywords: ["utility", "electric", "water", "internet", "comcast", "verizon", "at&t", "tmobile", "phone"] },
  { category: "Entertainment", keywords: ["netflix", "spotify", "hulu", "cinema", "movie", "steam"] },
  { category: "Shopping", keywords: ["amazon", "marketplace", "etsy", "best buy", "apple", "store"] },
  { category: "Health", keywords: ["pharmacy", "walgreens", "cvs", "hospital", "dental", "medical"] },
  { category: "Savings Transfer", keywords: ["transfer to savings", "savings transfer", "ally savings", "capital one savings"] },
  { category: "Income", keywords: ["payroll", "salary", "deposit", "cashout", "refund", "reimbursement", "interest"] }
];

const els = {
  fileInput: document.getElementById("statement-file"),
  textInput: document.getElementById("statement-text"),
  analyzeButton: document.getElementById("analyze-button"),
  clearButton: document.getElementById("clear-button"),
  loadSampleButton: document.getElementById("load-sample"),
  statusMessage: document.getElementById("status-message"),
  summaryCards: document.getElementById("summary-cards"),
  summaryRange: document.getElementById("summary-range"),
  categoryBreakdown: document.getElementById("category-breakdown"),
  merchantBreakdown: document.getElementById("merchant-breakdown"),
  transactionsBody: document.getElementById("transactions-body"),
  transactionCount: document.getElementById("transaction-count"),
  uploadZone: document.querySelector(".upload-zone")
};

const PDF_DATE_PATTERN = /\b(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/;
const PDF_AMOUNT_PATTERN = /-?\$?\(?\d[\d,\s]*\.\d{2}\)?/g;
const OCR_CONFIG = {
  workerPath: "vendor/tesseract.worker.min.js",
  corePath: "https://unpkg.com/tesseract.js-core@5/tesseract-core.wasm.js",
  langPath: "https://tessdata.projectnaptha.com/4.0.0_best"
};

bindEvents();

function bindEvents() {
  els.fileInput.addEventListener("change", handleFileImport);
  els.analyzeButton.addEventListener("click", analyzeFromText);
  els.clearButton.addEventListener("click", clearAll);
  els.loadSampleButton.addEventListener("click", loadSample);

  ["dragenter", "dragover"].forEach((eventName) => {
    els.uploadZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.uploadZone.classList.add("dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    els.uploadZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.uploadZone.classList.remove("dragging");
    });
  });

  els.uploadZone.addEventListener("drop", (event) => {
    const [file] = event.dataTransfer.files;
    if (file) {
      void readFile(file);
    }
  });
}

function handleFileImport(event) {
  const [file] = event.target.files;
  if (file) {
    void readFile(file);
  }
}

async function readFile(file) {
  if (await isPdfFile(file)) {
    await readPdf(file);
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    els.textInput.value = String(reader.result || "");
    setStatus(`Loaded ${file.name}. Review the CSV if needed, then analyze it.`);
    analyzeStatement(els.textInput.value);
  };
  reader.onerror = () => {
    setStatus("Could not read that file. Try exporting your statement as CSV and upload it again.");
  };
  reader.readAsText(file);
}

async function readPdf(file) {
  els.textInput.value = "";
  setStatus(`Reading ${file.name}... extracting transactions from the PDF.`);

  try {
    const pdf = await loadPdfDocument(file);
    const extractedText = await extractPdfTextFromDocument(pdf);
    let csvText = pdfTextToCsv(extractedText);

    if (!csvText) {
      setStatus(`Reading ${file.name}... no usable embedded text found, switching to OCR.`);
      const ocrText = await extractPdfTextWithOcr(pdf);
      csvText = pdfTextToCsv(ocrText);

      if (!csvText) {
        const extractionIssue = detectPdfExtractionIssue(ocrText, true);
        setStatus(extractionIssue || "I ran OCR on the PDF, but I still could not confidently find transaction rows. We may need to tune the ECU-specific parser next.");
        return;
      }
    }

    els.textInput.value = csvText;
    analyzeStatement(csvText);
  } catch (error) {
    els.textInput.value = "";
    setStatus(`Could not read that PDF. ${error.message}`);
  }
}

async function isPdfFile(file) {
  const normalizedName = file.name.toLowerCase();
  const normalizedType = (file.type || "").toLowerCase();

  if (normalizedName.endsWith(".pdf") || normalizedType === "application/pdf") {
    return true;
  }

  try {
    const headerBuffer = await file.slice(0, 5).arrayBuffer();
    const headerBytes = new Uint8Array(headerBuffer);
    const headerText = String.fromCharCode(...headerBytes);
    return headerText === "%PDF-";
  } catch (_error) {
    return false;
  }
}

function analyzeFromText() {
  analyzeStatement(els.textInput.value);
}

function loadSample() {
  els.textInput.value = SAMPLE_CSV;
  analyzeStatement(SAMPLE_CSV);
}

function clearAll() {
  els.fileInput.value = "";
  els.textInput.value = "";
  setStatus("Upload or paste a statement to begin.");
  els.summaryRange.textContent = "No statement loaded yet";
  els.transactionCount.textContent = "0 transactions";
  els.summaryCards.innerHTML = "<p>Your totals will appear here after import.</p>";
  els.summaryCards.classList.add("empty-state");
  els.categoryBreakdown.innerHTML = "<p>No spending categories yet.</p>";
  els.categoryBreakdown.classList.add("empty-state");
  els.merchantBreakdown.innerHTML = "<p>No merchant totals yet.</p>";
  els.merchantBreakdown.classList.add("empty-state");
  els.transactionsBody.innerHTML = `
    <tr>
      <td colspan="5" class="table-empty">No statement imported yet.</td>
    </tr>
  `;
}

function analyzeStatement(csvText) {
  if (!csvText.trim()) {
    setStatus("Paste statement rows or upload a CSV file first.");
    return;
  }

  let parsed;
  try {
    parsed = parseCsv(csvText);
  } catch (error) {
    setStatus(`Could not parse the CSV: ${error.message}`);
    return;
  }

  if (!parsed.length) {
    setStatus("The statement looks empty. Make sure the first row contains headers and the file has data rows.");
    return;
  }

  const transactions = parsed
    .map(normalizeTransaction)
    .filter(Boolean)
    .sort((left, right) => left.dateValue - right.dateValue);

  if (!transactions.length) {
    setStatus("I found rows, but none looked like valid transactions. Check for date, description, and amount columns.");
    return;
  }

  const summary = buildSummary(transactions);
  renderSummary(summary);
  renderBreakdown(els.categoryBreakdown, summary.categorySpend, summary.totalSpent);
  renderBreakdown(els.merchantBreakdown, summary.topMerchants, summary.topMerchants[0]?.amount || 0);
  renderTransactions(transactions);

  const invalidRows = parsed.length - transactions.length;
  const skippedMessage = invalidRows > 0 ? ` Skipped ${invalidRows} row${invalidRows === 1 ? "" : "s"} that were missing key fields.` : "";
  setStatus(`Analyzed ${transactions.length} transaction${transactions.length === 1 ? "" : "s"}.${skippedMessage}`);
}

async function loadPdfDocument(file) {
  const pdfjsLib = window.pdfjsLib;

  if (!pdfjsLib) {
    throw new Error("PDF support did not load. Refresh the page and try again.");
  }

  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

  const buffer = await file.arrayBuffer();
  const documentTask = pdfjsLib.getDocument({ data: buffer });
  return documentTask.promise;
}

async function extractPdfTextFromDocument(pdf) {
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const lines = groupPdfItemsIntoLines(textContent.items);
    pages.push(lines.join("\n"));
  }

  return pages.join("\n");
}

async function extractPdfTextWithOcr(pdf) {
  const Tesseract = window.Tesseract;

  if (!Tesseract || typeof Tesseract.createWorker !== "function") {
    throw new Error("OCR support did not load. Refresh the page and try again.");
  }

  const worker = await Tesseract.createWorker("eng", 1, OCR_CONFIG);
  const pages = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      setStatus(`Running OCR on page ${pageNumber} of ${pdf.numPages}... this can take a minute for scanned statements.`);
      const page = await pdf.getPage(pageNumber);
      const canvas = await renderPdfPageToCanvas(page, 2);
      const {
        data: { lines, text }
      } = await worker.recognize(canvas);

      const pageLines = Array.isArray(lines) && lines.length
        ? lines.map((line) => normalizeOcrLine(line.text)).filter(Boolean)
        : String(text || "")
          .split("\n")
          .map((line) => normalizeOcrLine(line))
          .filter(Boolean);

      pages.push(pageLines.join("\n"));
    }
  } finally {
    await worker.terminate();
  }

  return pages.join("\n");
}

async function renderPdfPageToCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    throw new Error("Could not create a canvas for OCR.");
  }

  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  await page.render({
    canvasContext: context,
    viewport
  }).promise;

  return canvas;
}

function groupPdfItemsIntoLines(items) {
  const rows = new Map();

  items.forEach((item) => {
    if (!("str" in item) || !item.str.trim()) {
      return;
    }

    const y = Math.round(item.transform[5]);
    const row = rows.get(y) || [];
    row.push({
      x: item.transform[4],
      text: item.str.trim()
    });
    rows.set(y, row);
  });

  return Array.from(rows.entries())
    .sort((left, right) => right[0] - left[0])
    .map(([, lineItems]) => lineItems
      .sort((left, right) => left.x - right.x)
      .map((item) => item.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
    )
    .filter(Boolean);
}

function normalizeOcrLine(line) {
  return String(line || "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function detectPdfExtractionIssue(pdfText, fromOcr = false) {
  const trimmed = pdfText.trim();

  if (!trimmed) {
    return fromOcr
      ? "I ran OCR on the scanned PDF, but still could not pull readable transaction text from it."
      : "This PDF looks like a scanned or image-only statement, so the browser could not extract text from it. OCR is required for this file.";
  }

  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  const suspiciousLineCount = lines.filter((line) =>
    /^(%PDF-|xref|trailer|startxref|endobj|obj\b|stream\b|endstream\b)/i.test(line) ||
    /\/Type\/|\/Subtype\/|\/Filter\/|\/Length\b/.test(line)
  ).length;

  if (suspiciousLineCount >= 5) {
    return "This file looks like raw PDF internals instead of statement text. The statement is likely scanned or otherwise not text-extractable. Try a CSV export, or an OCR-processed PDF.";
  }

  const transactionLikeLines = lines.filter((line) =>
    PDF_DATE_PATTERN.test(line) && (line.match(PDF_AMOUNT_PATTERN) || []).length
  ).length;

  if (!transactionLikeLines && lines.length > 20) {
    return fromOcr
      ? "I ran OCR on the PDF, but the text still does not look like transaction rows. The ECU layout may need bank-specific tuning."
      : "I could read some text from the PDF, but it does not look like transaction rows. This usually means the statement is scanned, image-heavy, or uses a layout this parser cannot read yet.";
  }

  return "";
}

function pdfTextToCsv(pdfText) {
  const lines = pdfText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const records = [];

  lines.forEach((line) => {
    const record = parsePdfTransactionLine(line);
    if (record) {
      records.push(record);
    }
  });

  if (!records.length) {
    return "";
  }

  return [
    "Date,Description,Amount",
    ...records.map((record) => `${record.date},"${record.description.replace(/"/g, '""')}",${record.amount}`)
  ].join("\n");
}

function parsePdfTransactionLine(line) {
  const normalizedLine = normalizePotentialTransactionLine(line);

  if (!PDF_DATE_PATTERN.test(normalizedLine)) {
    return null;
  }

  const dateMatch = normalizedLine.match(PDF_DATE_PATTERN);
  const amountMatches = [...normalizedLine.matchAll(PDF_AMOUNT_PATTERN)];

  if (!dateMatch || !amountMatches.length) {
    return null;
  }

  const date = normalizePdfDate(dateMatch[1]);
  const amountToken = amountMatches[amountMatches.length - 1][0];
  const amount = numericValue(amountToken);

  if (!date || amount === null) {
    return null;
  }

  const cleanedDescription = normalizedLine
    .replace(dateMatch[0], "")
    .replace(amountToken, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanedDescription || cleanedDescription.length < 2) {
    return null;
  }

  if (looksLikeNonTransaction(cleanedDescription)) {
    return null;
  }

  return { date, description: cleanedDescription, amount };
}

function normalizePotentialTransactionLine(line) {
  return String(line || "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\$\s+/g, "$")
    .replace(/(?<=\d),(?=\s+\d{3}\b)/g, "")
    .trim();
}

function normalizePdfDate(dateText) {
  const parts = dateText.split(/[/-]/).map((part) => part.trim());
  if (parts.length < 2) {
    return "";
  }

  const [month, day, yearPart] = parts;
  const year = yearPart
    ? yearPart.length === 2 ? `20${yearPart}` : yearPart
    : String(new Date().getFullYear());

  const paddedMonth = month.padStart(2, "0");
  const paddedDay = day.padStart(2, "0");
  return `${year}-${paddedMonth}-${paddedDay}`;
}

function looksLikeNonTransaction(text) {
  const normalized = text.toLowerCase();
  const blockedTerms = [
    "beginning balance",
    "ending balance",
    "daily balance",
    "account number",
    "member fdic",
    "page ",
    "statement period",
    "total deposits",
    "total withdrawals",
    "balance summary"
  ];

  return blockedTerms.some((term) => normalized.includes(term));
}

function parseCsv(csvText) {
  const rows = [];
  let current = "";
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    const next = csvText[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(current);
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(current);
      current = "";
      if (row.some((cell) => cell.trim() !== "")) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    current += char;
  }

  if (current !== "" || row.length) {
    row.push(current);
    if (row.some((cell) => cell.trim() !== "")) {
      rows.push(row);
    }
  }

  if (rows.length < 2) {
    return [];
  }

  const headers = rows[0].map((header) => normalizeHeader(header));
  return rows.slice(1).map((cells) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = (cells[index] || "").trim();
    });
    return record;
  });
}

function normalizeTransaction(record) {
  const dateText = firstValue(record, ["date", "posteddate", "transactiondate"]);
  const description = firstValue(record, ["description", "merchant", "details", "memo", "name"]);
  const amountText = firstValue(record, ["amount", "transactionamount"]);
  const debitText = firstValue(record, ["debit", "withdrawal", "outflow"]);
  const creditText = firstValue(record, ["credit", "deposit", "inflow"]);

  if (!dateText || !description || (!amountText && !debitText && !creditText)) {
    return null;
  }

  const date = new Date(dateText);
  if (Number.isNaN(date.valueOf())) {
    return null;
  }

  const amount = parseAmount(amountText, debitText, creditText);
  if (amount === null) {
    return null;
  }

  const cleanedDescription = cleanDescription(description);
  const category = inferCategory(cleanedDescription, amount);
  const type = inferType(category, amount);

  return {
    date,
    dateValue: date.valueOf(),
    dateLabel: date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    description: cleanedDescription,
    amount,
    category,
    type
  };
}

function parseAmount(amountText, debitText, creditText) {
  if (amountText) {
    return numericValue(amountText);
  }

  const debit = numericValue(debitText);
  const credit = numericValue(creditText);

  if (credit !== null && credit !== 0) {
    return Math.abs(credit);
  }

  if (debit !== null && debit !== 0) {
    return -Math.abs(debit);
  }

  if (credit === 0) {
    return 0;
  }

  if (debit === 0) {
    return 0;
  }

  return null;
}

function numericValue(text) {
  if (!text) {
    return null;
  }

  const sanitized = text
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, "")
    .replace(/\(([^)]+)\)/, "-$1")
    .trim();

  if (!sanitized) {
    return null;
  }

  const amount = Number(sanitized);
  return Number.isFinite(amount) ? amount : null;
}

function inferCategory(description, amount) {
  const normalized = description.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((keyword) => normalized.includes(keyword))) {
      return rule.category;
    }
  }

  if (amount > 0) {
    return "Income";
  }

  return "Other";
}

function inferType(category, amount) {
  if (category === "Savings Transfer") {
    return "Transfer";
  }

  return amount >= 0 ? "Income" : "Expense";
}

function buildSummary(transactions) {
  const incomeTransactions = transactions.filter((transaction) => transaction.type === "Income");
  const expenseTransactions = transactions.filter((transaction) => transaction.type === "Expense");
  const transferTransactions = transactions.filter((transaction) => transaction.type === "Transfer");

  const totalIncome = sumAmounts(incomeTransactions, (transaction) => transaction.amount);
  const totalSpent = Math.abs(sumAmounts(expenseTransactions, (transaction) => transaction.amount));
  const savingsTransfers = Math.abs(sumAmounts(transferTransactions, (transaction) => transaction.amount));
  const netCashFlow = totalIncome - totalSpent - savingsTransfers;

  const categorySpend = toSortedTotals(expenseTransactions, (transaction) => transaction.category);
  const topMerchants = toSortedTotals(
    expenseTransactions.concat(transferTransactions),
    (transaction) => transaction.description,
    6
  );

  const firstDate = transactions[0].date;
  const lastDate = transactions[transactions.length - 1].date;

  return {
    totalIncome,
    totalSpent,
    savingsTransfers,
    netCashFlow,
    totalTransactions: transactions.length,
    categorySpend,
    topMerchants,
    rangeLabel: `${firstDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} - ${lastDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
  };
}

function toSortedTotals(transactions, keyFn, limit = 7) {
  const totals = new Map();

  transactions.forEach((transaction) => {
    const key = keyFn(transaction);
    const amount = Math.abs(transaction.amount);
    totals.set(key, (totals.get(key) || 0) + amount);
  });

  return Array.from(totals.entries())
    .map(([label, amount]) => ({ label, amount }))
    .sort((left, right) => right.amount - left.amount)
    .slice(0, limit);
}

function renderSummary(summary) {
  els.summaryRange.textContent = summary.rangeLabel;
  els.transactionCount.textContent = `${summary.totalTransactions} transaction${summary.totalTransactions === 1 ? "" : "s"}`;
  els.summaryCards.classList.remove("empty-state");
  els.summaryCards.innerHTML = [
    summaryCard("Income", money(summary.totalIncome), "Money coming in"),
    summaryCard("Spent", money(summary.totalSpent), "Total expenses"),
    summaryCard("Savings", money(summary.savingsTransfers), "Transfers to savings"),
    summaryCard("Net", money(summary.netCashFlow), summary.netCashFlow >= 0 ? "Left after expenses" : "Overspent this period")
  ].join("");
}

function renderBreakdown(container, items, scaleTotal) {
  if (!items.length || !scaleTotal) {
    container.innerHTML = "<p>Not enough data to build this breakdown yet.</p>";
    container.classList.add("empty-state");
    return;
  }

  container.classList.remove("empty-state");
  container.innerHTML = items.map((item) => {
    const width = Math.max(6, (item.amount / scaleTotal) * 100);
    return `
      <div class="breakdown-row">
        <span class="breakdown-label">${escapeHtml(item.label)}</span>
        <span class="breakdown-amount">${money(item.amount)}</span>
        <div class="bar-track">
          <div class="bar-fill" style="width: ${Math.min(width, 100)}%"></div>
        </div>
      </div>
    `;
  }).join("");
}

function renderTransactions(transactions) {
  els.transactionsBody.innerHTML = transactions.map((transaction) => {
    const amountClass = transaction.type === "Income"
      ? "amount-income"
      : transaction.type === "Transfer"
        ? "amount-transfer"
        : "amount-expense";

    return `
      <tr>
        <td>${transaction.dateLabel}</td>
        <td>${escapeHtml(transaction.description)}</td>
        <td>${escapeHtml(transaction.category)}</td>
        <td><span class="type-chip">${transaction.type}</span></td>
        <td class="${amountClass}">${money(transaction.amount)}</td>
      </tr>
    `;
  }).join("");
}

function summaryCard(label, value, detail) {
  return `
    <article class="summary-card">
      <label>${label}</label>
      <strong>${value}</strong>
      <p>${detail}</p>
    </article>
  `;
}

function sumAmounts(items, amountFn) {
  return items.reduce((total, item) => total + amountFn(item), 0);
}

function firstValue(record, keys) {
  for (const key of keys) {
    if (record[key]) {
      return record[key];
    }
  }
  return "";
}

function normalizeHeader(header) {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cleanDescription(description) {
  return description
    .replace(/\s+/g, " ")
    .replace(/\bpos\b/ig, "")
    .replace(/\bdebit\b/ig, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function money(amount) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(amount);
}

function setStatus(message) {
  els.statusMessage.textContent = message;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
