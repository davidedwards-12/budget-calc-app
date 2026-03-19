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
  { category: "Savings Transfer", keywords: ["transfer", "xfer", "transfer to savings", "savings transfer", "transfer from", "transfer to", "ally savings", "capital one savings"] },
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
  runningTotalHeader: document.getElementById("running-total-header"),
  uploadZone: document.querySelector(".upload-zone")
};

const PDF_DATE_PATTERN = /\b(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/;
const PDF_AMOUNT_PATTERN = /-?\$?\(?\d[\d,\s]*\.\d{2}\)?/g;
const OPENING_BALANCE_LABEL_PATTERN = /(?:start(?:ing)?|begin(?:ning)?|open(?:ing)?|previous)\s+bal(?:a|e)\s*nce|balance\s+forward/i;
const OCR_CONFIG = {
  workerPath: "vendor/tesseract.worker.min.js",
  corePath: "https://unpkg.com/tesseract.js-core@5/tesseract-core.wasm.js",
  langPath: "https://tessdata.projectnaptha.com/4.0.0_best"
};

let currentImportMeta = createEmptyImportMeta();

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
    currentImportMeta = extractStatementMeta(extractedText, file.name);
    const focusedExtractedText = extractFocusedStatementText(extractedText, currentImportMeta.focusAccount);
    let csvText = pdfTextToCsv(focusedExtractedText || extractedText);

    if (!csvText) {
      setStatus(`Reading ${file.name}... no usable embedded text found, switching to OCR.`);
      const ocrText = await extractPdfTextWithOcr(pdf);
      currentImportMeta = extractStatementMeta(ocrText, file.name);
      const focusedOcrText = extractFocusedStatementText(ocrText, currentImportMeta.focusAccount);
      csvText = pdfTextToCsv(focusedOcrText || ocrText);

      if (!csvText) {
        const extractionIssue = detectPdfExtractionIssue(ocrText, true);
        setStatus(extractionIssue || "I ran OCR on the PDF, but I still could not confidently find transaction rows. We may need to tune the ECU-specific parser next.");
        return;
      }
    }

    els.textInput.value = csvText;
    analyzeStatement(csvText, currentImportMeta);
  } catch (error) {
    els.textInput.value = "";
    currentImportMeta = createEmptyImportMeta();
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
  currentImportMeta = createEmptyImportMeta();
  analyzeStatement(els.textInput.value);
}

function loadSample() {
  els.textInput.value = SAMPLE_CSV;
  currentImportMeta = createEmptyImportMeta();
  analyzeStatement(SAMPLE_CSV, currentImportMeta);
}

function clearAll() {
  els.fileInput.value = "";
  els.textInput.value = "";
  currentImportMeta = createEmptyImportMeta();
  setStatus("Upload or paste a statement to begin.");
  els.summaryRange.textContent = "No statement loaded yet";
  els.transactionCount.textContent = "0 transactions";
  els.runningTotalHeader.textContent = "Running Net";
  els.summaryCards.innerHTML = "<p>Your totals will appear here after import.</p>";
  els.summaryCards.classList.add("empty-state");
  els.categoryBreakdown.innerHTML = "<p>No spending categories yet.</p>";
  els.categoryBreakdown.classList.add("empty-state");
  els.merchantBreakdown.innerHTML = "<p>No merchant totals yet.</p>";
  els.merchantBreakdown.classList.add("empty-state");
  els.transactionsBody.innerHTML = `
    <tr>
      <td colspan="7" class="table-empty">No statement imported yet.</td>
    </tr>
  `;
}

function analyzeStatement(csvText, importMeta = currentImportMeta) {
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
    .filter((transaction) => shouldIncludeTransaction(transaction, importMeta))
    .sort((left, right) => left.dateValue - right.dateValue);

  if (!transactions.length) {
    setStatus("I found rows, but none looked like valid transactions. Check for date, description, and amount columns.");
    return;
  }

  if (importMeta?.openingBalance === null) {
    const inferredOpeningBalance = inferOpeningBalanceFromFirstTransaction(transactions, importMeta);
    if (inferredOpeningBalance !== null) {
      importMeta.openingBalance = inferredOpeningBalance;
    }
  }

  const summary = buildSummary(transactions);
  renderSummary(summary);
  renderBreakdown(els.categoryBreakdown, summary.categorySpend, summary.totalSpent);
  renderBreakdown(els.merchantBreakdown, summary.topMerchants, summary.topMerchants[0]?.amount || 0);
  renderTransactions(transactions, importMeta);

  const invalidRows = parsed.length - transactions.length;
  const skippedMessage = invalidRows > 0 ? ` Skipped ${invalidRows} row${invalidRows === 1 ? "" : "s"} that were missing key fields.` : "";
  const balanceMessage = buildBalanceStatusMessage(importMeta);
  setStatus(`Analyzed ${transactions.length} transaction${transactions.length === 1 ? "" : "s"}.${skippedMessage}${balanceMessage}`);
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
  let currentAccount = "";

  lines.forEach((line) => {
    currentAccount = detectAccountFromLine(line) || currentAccount;
    const record = parsePdfTransactionLine(line, currentAccount);
    if (record) {
      records.push(record);
    }
  });

  if (!records.length) {
    return "";
  }

  return [
    "Date,Account,Description,Amount,BalanceHint",
    ...records.map((record) => `${record.date},"${record.account.replace(/"/g, '""')}","${record.description.replace(/"/g, '""')}",${record.amount},${record.balanceHint ?? ""}`)
  ].join("\n");
}

function parsePdfTransactionLine(line, account = "") {
  const normalizedLine = normalizePotentialTransactionLine(line);
  const dateMatches = [...normalizedLine.matchAll(new RegExp(PDF_DATE_PATTERN, "g"))];
  const amountMatches = [...normalizedLine.matchAll(PDF_AMOUNT_PATTERN)];

  if (looksLikeSummaryGridLine(normalizedLine, dateMatches, amountMatches)) {
    return null;
  }

  if (!PDF_DATE_PATTERN.test(normalizedLine)) {
    return null;
  }

  const dateMatch = normalizedLine.match(PDF_DATE_PATTERN);

  if (!dateMatch || !amountMatches.length) {
    return null;
  }

  const date = normalizePdfDate(dateMatch[1]);
  const selectedAmount = selectTransactionAmount(normalizedLine, amountMatches);
  const amount = selectedAmount?.value ?? null;

  if (!date || amount === null) {
    return null;
  }

  const cleanedDescription = normalizedLine
    .replace(dateMatch[0], "")
    .replace(PDF_AMOUNT_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanedDescription || cleanedDescription.length < 2) {
    return null;
  }

  if (!/[a-z]/i.test(cleanedDescription)) {
    return null;
  }

  if (looksLikeNonTransaction(cleanedDescription)) {
    return null;
  }

  return {
    date,
    account: account || "Unknown",
    description: cleanedDescription,
    amount,
    balanceHint: extractBalanceHint(amountMatches, selectedAmount)
  };
}

function selectTransactionAmount(line, amountMatches) {
  const candidates = amountMatches
    .map((match) => {
      const token = match[0];
      const value = numericValue(token);

      if (value === null) {
        return null;
      }

      return {
        token,
        value,
        index: match.index ?? 0,
        explicitNegative: /^-\$?\(?/.test(token.trim()) || /^\(\$?/.test(token.trim()),
        absoluteValue: Math.abs(value)
      };
    })
    .filter(Boolean);

  if (!candidates.length) {
    return null;
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  const normalizedLine = line.toLowerCase();
  const debitLikeLine = looksLikeExpenseDescription(normalizedLine);
  const creditLikeLine = looksLikeIncomeDescription(normalizedLine);

  if (debitLikeLine) {
    const explicitNegativeCandidates = candidates.filter((candidate) => candidate.explicitNegative);
    if (explicitNegativeCandidates.length) {
      return explicitNegativeCandidates.sort(compareAmountCandidates)[0];
    }
  }

  if (creditLikeLine) {
    const nonNegativeCandidates = candidates.filter((candidate) => !candidate.explicitNegative);
    if (nonNegativeCandidates.length) {
      return nonNegativeCandidates.sort(compareAmountCandidates)[0];
    }
  }

  return candidates.sort(compareAmountCandidates)[0];
}

function compareAmountCandidates(left, right) {
  if (left.absoluteValue !== right.absoluteValue) {
    return left.absoluteValue - right.absoluteValue;
  }

  return left.index - right.index;
}

function extractBalanceHint(amountMatches, selectedAmount) {
  if (!selectedAmount || amountMatches.length < 2) {
    return null;
  }

  const remainingCandidates = amountMatches
    .map((match) => ({
      index: match.index ?? 0,
      value: numericValue(match[0])
    }))
    .filter((candidate) => candidate.value !== null)
    .filter((candidate) => !(candidate.index === selectedAmount.index && candidate.value === selectedAmount.value))
    .filter((candidate) => candidate.value >= 0);

  if (!remainingCandidates.length) {
    return null;
  }

  return remainingCandidates.sort((left, right) => right.index - left.index)[0].value;
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

function createEmptyImportMeta() {
  return {
    openingBalance: null,
    accountTypes: [],
    statementYear: null,
    focusAccount: null
  };
}

function extractStatementMeta(statementText, fileName = "") {
  const text = String(statementText || "");
  const normalized = text.toLowerCase();
  const accountTypes = new Set();
  const focusAccount = "Checking";

  if (normalized.includes("checking statement")) {
    accountTypes.add("Checking");
  }

  if (normalized.includes("savings statement")) {
    accountTypes.add("Savings");
  }

  if (normalized.includes("withdrawals, fees and other debits")) {
    accountTypes.add("Checking");
  }

  if (
    normalized.includes("deposits, dividends and other credits") ||
    normalized.includes("dividend rate summary") ||
    normalized.includes("total dividends")
  ) {
    accountTypes.add("Savings");
  }

  const focusedText = extractFocusedStatementText(text, focusAccount);
  const openingBalance = focusedText
    ? extractOpeningBalance(focusedText)
    : extractOpeningBalanceByAccountContext(text, focusAccount);

  return {
    openingBalance,
    accountTypes: Array.from(accountTypes),
    statementYear: extractStatementYear(text, fileName),
    focusAccount
  };
}

function extractFocusedStatementText(statementText, focusAccount) {
  const text = String(statementText || "");
  if (!text.trim() || !focusAccount) {
    return "";
  }

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const focusHeader = focusAccount.toLowerCase() === "checking" ? "checking statement" : "savings statement";
  const otherHeader = focusAccount.toLowerCase() === "checking" ? "savings statement" : "checking statement";
  const focusStartIndex = lines.findIndex((line) => line.toLowerCase().includes(focusHeader));

  if (focusStartIndex === -1) {
    return "";
  }

  const focusLines = [];

  for (let index = focusStartIndex; index < lines.length; index += 1) {
    const normalizedLine = lines[index].toLowerCase();

    if (index > focusStartIndex && normalizedLine.includes(otherHeader)) {
      break;
    }

    focusLines.push(lines[index]);
  }

  return focusLines.join("\n");
}

function extractStatementYear(statementText, fileName = "") {
  const sources = [String(statementText || ""), String(fileName || "")];

  for (const source of sources) {
    const fullDateMatch = source.match(/\b(?:\d{1,2}[/-]\d{1,2}[/-](20\d{2})|(20\d{2})[-/]\d{1,2}[-/]\d{1,2})\b/);
    if (fullDateMatch) {
      return Number(fullDateMatch[1] || fullDateMatch[2]);
    }

    const monthYearMatch = source.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s_-]*(20\d{2})\b/i);
    if (monthYearMatch) {
      return Number(monthYearMatch[1]);
    }

    const yearOnlyMatch = source.match(/\b(20\d{2})\b/);
    if (yearOnlyMatch) {
      return Number(yearOnlyMatch[1]);
    }
  }

  return new Date().getFullYear();
}

function detectAccountFromLine(line) {
  const normalized = String(line || "").toLowerCase();

  if (normalized.includes("checking statement")) {
    return "Checking";
  }

  if (normalized.includes("savings statement")) {
    return "Savings";
  }

  return "";
}

function extractOpeningBalance(statementText) {
  const fullText = String(statementText || "");
  const normalizedText = normalizeBalanceLabelText(fullText);
  const openingBalancePattern = /(?:start(?:ing)?|begin(?:ning)?|open(?:ing)?|previous)\s+bal(?:a|e)nce[\s:$-]*(-?\$?\(?\d[\d,\s]*\.\d{2}\)?)/i;
  const inlineMatch = normalizedText.match(openingBalancePattern);

  if (inlineMatch) {
    const inlineOpeningBalance = numericValue(inlineMatch[1]);
    if (inlineOpeningBalance !== null) {
      return inlineOpeningBalance;
    }
  }

  const lines = fullText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const normalizedLine = normalizeBalanceLabelText(line);

    if (!OPENING_BALANCE_LABEL_PATTERN.test(normalizedLine)) {
      continue;
    }

    const amountMatches = [...line.matchAll(PDF_AMOUNT_PATTERN)];
    if (!amountMatches.length) {
      continue;
    }

    const openingBalance = numericValue(amountMatches[amountMatches.length - 1][0]);
    if (openingBalance !== null) {
      return openingBalance;
    }
  }

  return null;
}

function extractOpeningBalanceByAccountContext(statementText, focusAccount) {
  const lines = String(statementText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length || !focusAccount) {
    return null;
  }

  const preferredMarkers = focusAccount === "Checking"
    ? [
      "checking statement",
      "withdrawals, fees and other debits",
      "checks cleared",
      "w/d ",
      "ext w/d",
      "billpay",
      "ach debit",
      "debit card"
    ]
    : ["savings statement", "dividend rate summary", "total dividends", "deposits, dividends and other credits"];
  const opposingMarkers = focusAccount === "Checking"
    ? ["savings statement", "dividend rate summary", "total dividends", "deposits, dividends and other credits"]
    : ["checking statement", "withdrawals, fees and other debits", "checks cleared"];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalizedLine = normalizeBalanceLabelText(line);

    if (!OPENING_BALANCE_LABEL_PATTERN.test(normalizedLine)) {
      continue;
    }

    const candidateLines = [
      line,
      `${line} ${lines[index + 1] || ""}`.trim(),
      `${line} ${lines[index + 1] || ""} ${lines[index + 2] || ""}`.trim()
    ];

    const amountMatches = candidateLines
      .map((candidateLine) => [...candidateLine.matchAll(PDF_AMOUNT_PATTERN)])
      .find((matches) => matches.length) || [];

    if (!amountMatches.length) {
      continue;
    }

    const contextWindow = lines
      .slice(Math.max(0, index - 20), Math.min(lines.length, index + 21))
      .join(" ")
      .toLowerCase();
    const matchesPreferredContext = preferredMarkers.some((marker) => contextWindow.includes(marker));
    const matchesOpposingContext = opposingMarkers.some((marker) => contextWindow.includes(marker));

    if (!matchesPreferredContext || matchesOpposingContext) {
      continue;
    }

    const openingBalance = numericValue(amountMatches[amountMatches.length - 1][0]);
    if (openingBalance !== null) {
      return openingBalance;
    }
  }

  return null;
}

function inferOpeningBalanceFromFirstTransaction(transactions, importMeta) {
  if (!Array.isArray(transactions) || !transactions.length || importMeta?.focusAccount !== "Checking") {
    return null;
  }

  const firstCheckingTransaction = transactions.find((transaction) =>
    transaction.account === "Checking" && transaction.balanceHint !== null
  );

  if (!firstCheckingTransaction) {
    return null;
  }

  return firstCheckingTransaction.balanceHint - firstCheckingTransaction.amount;
}

function normalizeBalanceLabelText(text) {
  return String(text || "")
    .replace(/\bbal\s+ance\b/gi, "balance")
    .replace(/\bbalence\b/gi, "balance")
    .replace(/\bbegining\b/gi, "beginning")
    .replace(/\s+/g, " ")
    .trim();
}

function hasMultipleAccountTypes(importMeta) {
  return Array.isArray(importMeta?.accountTypes) && importMeta.accountTypes.length > 1;
}

function canShowRunningBalance(importMeta) {
  if (importMeta?.focusAccount === "Checking") {
    return importMeta?.openingBalance !== null;
  }

  return importMeta?.openingBalance !== null && !hasMultipleAccountTypes(importMeta);
}

function buildBalanceStatusMessage(importMeta) {
  if (importMeta?.focusAccount === "Checking") {
    return " Showing checking-account transactions only.";
  }

  if (hasMultipleAccountTypes(importMeta)) {
    return " This PDF appears to include both checking and savings sections, so the last column is shown as net movement instead of a true account balance.";
  }

  if (importMeta?.openingBalance !== null) {
    return ` Using starting balance ${money(importMeta.openingBalance)} for the running balance column.`;
  }

  return "";
}

function shouldIncludeTransaction(transaction, importMeta) {
  if (importMeta?.focusAccount !== "Checking") {
    return true;
  }

  return transaction.account === "Checking" || transaction.account === "Unknown";
}

function looksLikeSummaryGridLine(line, dateMatches, amountMatches) {
  const alphaCharacterCount = (line.match(/[a-z]/gi) || []).length;

  if (dateMatches.length >= 2 && amountMatches.length >= 2) {
    return true;
  }

  if (dateMatches.length >= 1 && amountMatches.length >= 3) {
    return true;
  }

  if (/date\s+amount/i.test(line)) {
    return true;
  }

  if (alphaCharacterCount === 0 && dateMatches.length >= 1 && amountMatches.length >= 2) {
    return true;
  }

  if (alphaCharacterCount <= 4 && dateMatches.length >= 1 && amountMatches.length >= 2) {
    return true;
  }

  return false;
}

function normalizePdfDate(dateText) {
  const parts = dateText.split(/[/-]/).map((part) => part.trim());
  if (parts.length < 2) {
    return "";
  }

  const [month, day, yearPart] = parts;
  const year = yearPart
    ? yearPart.length === 2 ? `20${yearPart}` : yearPart
    : String(currentImportMeta.statementYear || new Date().getFullYear());

  const paddedMonth = month.padStart(2, "0");
  const paddedDay = day.padStart(2, "0");
  return `${year}-${paddedMonth}-${paddedDay}`;
}

function looksLikeNonTransaction(text) {
  const normalized = text.toLowerCase();
  const blockedTerms = [
    "beginning balance",
    "starting balance",
    "ending balance",
    "daily balance",
    "account number",
    "member fdic",
    "page ",
    "statement period",
    "checking statement",
    "savings statement",
    "deposits, dividends and other credits",
    "withdrawals, fees and other debits",
    "total dividends",
    "total deposits",
    "total withdrawals",
    "total fees",
    "total number of checks cleared",
    "dividend rate summary",
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
  const rawAccount = firstValue(record, ["account"]);
  const description = firstValue(record, ["description", "merchant", "details", "memo", "name"]);
  const amountText = firstValue(record, ["amount", "transactionamount"]);
  const balanceHintText = firstValue(record, ["balancehint", "runningbalance", "balance"]);
  const debitText = firstValue(record, ["debit", "withdrawal", "outflow"]);
  const creditText = firstValue(record, ["credit", "deposit", "inflow"]);

  if (!dateText || !description || (!amountText && !debitText && !creditText)) {
    return null;
  }

  const date = new Date(dateText);
  if (Number.isNaN(date.valueOf())) {
    return null;
  }

  const cleanedDescription = cleanDescription(description);
  const account = inferAccount(rawAccount, cleanedDescription);
  const amount = normalizeSignedAmount(
    parseAmount(amountText, debitText, creditText),
    cleanedDescription
  );
  const balanceHint = numericValue(balanceHintText);

  if (amount === null) {
    return null;
  }

  const category = inferCategory(cleanedDescription, amount);
  const type = inferType(category, amount);

  return {
    date,
    dateValue: date.valueOf(),
    dateLabel: date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    account,
    description: cleanedDescription,
    amount,
    balanceHint,
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

function normalizeSignedAmount(amount, description) {
  if (amount === null) {
    return null;
  }

  const normalized = description.toLowerCase();

  if (amount > 0 && looksLikeExpenseDescription(normalized) && !looksLikeIncomeDescription(normalized)) {
    return -amount;
  }

  if (amount < 0 && looksLikeIncomeDescription(normalized) && !looksLikeExpenseDescription(normalized)) {
    return Math.abs(amount);
  }

  return amount;
}

function looksLikeExpenseDescription(normalizedDescription) {
  const expenseIndicators = [
    "w/d",
    "withdrawal",
    "purchase",
    "card purchase",
    "visa purchase",
    "dbt purchase",
    "debit card",
    "debit purchase",
    "pos ",
    "ach debit",
    "payment",
    "cafe",
    "restaurant",
    "market",
    "fuel",
    "gas",
    "coffee",
    "transfer to"
  ];

  return expenseIndicators.some((indicator) => normalizedDescription.includes(indicator));
}

function looksLikeIncomeDescription(normalizedDescription) {
  const incomeIndicators = [
    "deposit",
    "payroll",
    "salary",
    "refund",
    "reimbursement",
    "interest",
    "credit",
    "cashout",
    "direct dep"
  ];

  return incomeIndicators.some((indicator) => normalizedDescription.includes(indicator))
    && !normalizedDescription.includes("transfer from")
    && !normalizedDescription.includes("internet transfer");
}

function looksLikeTransferDescription(normalizedDescription) {
  return normalizedDescription.includes("transfer")
    || normalizedDescription.includes("xfer")
    || /(?:\bfrom\b|\bto\b).*(?:\bck\b|\bsav\b)/i.test(normalizedDescription);
}

function inferAccount(rawAccount, description) {
  const normalizedAccount = String(rawAccount || "").trim();
  if (normalizedAccount && normalizedAccount !== "Unknown") {
    return normalizedAccount;
  }

  const normalizedDescription = description.toLowerCase();

  if (/deposit .* from .* ck|internet transfer from .* ck/.test(normalizedDescription)) {
    return "Savings";
  }

  if (/deposit .* from .* sav|internet transfer from .* sav/.test(normalizedDescription)) {
    return "Checking";
  }

  if (/w\/d .* to .* sav|internet transfer to .* sav/.test(normalizedDescription)) {
    return "Checking";
  }

  if (/w\/d .* to .* ck|internet transfer to .* ck/.test(normalizedDescription)) {
    return "Savings";
  }

  if (/\bck\b|\bchecking\b/.test(normalizedDescription)) {
    return "Checking";
  }

  if (/\bsav\b|\bsavings\b/.test(normalizedDescription)) {
    return "Savings";
  }

  if (normalizedDescription.startsWith("w/d") || normalizedDescription.startsWith("ext w/d")) {
    return "Checking";
  }

  if (normalizedDescription.startsWith("ext deposit")) {
    return "Checking";
  }

  return "Unknown";
}

function inferCategory(description, amount) {
  const normalized = description.toLowerCase();

  if (looksLikeTransferDescription(normalized)) {
    return "Savings Transfer";
  }

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

function renderTransactions(transactions, importMeta = currentImportMeta) {
  let runningValue = importMeta.openingBalance ?? 0;
  const showRunningBalance = importMeta?.openingBalance !== null;
  const rows = [];

  els.runningTotalHeader.textContent = showRunningBalance ? "Running Balance" : "Running Net";

  if (importMeta?.openingBalance !== null) {
    rows.push(`
      <tr>
        <td></td>
        <td>${escapeHtml(importMeta.focusAccount || transactions[0]?.account || "Unknown")}</td>
        <td>Starting Balance</td>
        <td></td>
        <td></td>
        <td></td>
        <td class="${runningValue >= 0 ? "amount-income" : "amount-expense"}">${money(runningValue)}</td>
      </tr>
    `);
  }

  transactions.forEach((transaction) => {
    runningValue += transaction.amount;
    const amountClass = transaction.type === "Income"
      ? "amount-income"
      : transaction.type === "Transfer"
        ? "amount-transfer"
        : "amount-expense";

    rows.push(`
      <tr>
        <td>${transaction.dateLabel}</td>
        <td>${escapeHtml(transaction.account)}</td>
        <td>${escapeHtml(transaction.description)}</td>
        <td>${escapeHtml(transaction.category)}</td>
        <td><span class="type-chip">${transaction.type}</span></td>
        <td class="${amountClass}">${money(transaction.amount)}</td>
        <td class="${runningValue >= 0 ? "amount-income" : "amount-expense"}">${money(runningValue)}</td>
      </tr>
    `);
  });

  els.transactionsBody.innerHTML = rows.join("");
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
