// permissive ExcelJS stand-in: every property/call works; records sheet names and saved file
window.__xl = { sheets: [], calls: 0 };
(function () {
  const any = () => new Proxy(function () {}, { get: (t, k) => k === 'then' ? undefined : k === Symbol.toPrimitive ? () => 0 : k === 'length' ? 0 : (t[k] !== undefined ? t[k] : (t[k] = any())), set: (t, k, v) => { t[k] = v; return true }, apply: () => any() });
  window.ExcelJS = { Workbook: function () { const wb = any(); wb.addWorksheet = (n) => { window.__xl.sheets.push(n); return any() }; wb.addImage = () => 1; wb.xlsx = { writeBuffer: async () => new Uint8Array([1, 2, 3]) }; return wb } };
})();
