const express = require('express');
const { parse } = require('csv-parse/sync');
const api = require('@actual-app/api');
const swaggerUi = require('swagger-ui-express');
const swaggerDefinition = require('./swaggerDef');

const app = express();
// Zwiększamy limit, jeśli pliki CSV będą bardzo duże
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 5008;

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDefinition));

async function withActual(fn) {
  try {
    await api.init({
      serverURL: process.env.ACTUAL_SERVER_URL || 'http://localhost:5006',
      password: process.env.ACTUAL_PASSWORD,
      dataDir: './actual-data'
    });
    if (!process.env.ACTUAL_SYNC_ID) throw new Error("Brak ACTUAL_SYNC_ID");
    await api.downloadBudget(process.env.ACTUAL_SYNC_ID);
    const result = await fn();
    return result;
  } finally {
    try { await api.shutdown(); } catch (err) {}
  }
}

app.get('/accounts', async (req, res) => {
  try {
    const accounts = await withActual(() => api.getAccounts());
    res.json(accounts.map(a => ({ name: a.name, id: a.id, type: a.type })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/categories', async (req, res) => {
  try {
    const categories = await withActual(() => api.getCategoryGroups());
    res.json(categories);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/import', async (req, res) => {
  try {
    const { csvData, accountId, categoryMapping, accountMapping } = req.body;

    if (!csvData || !accountId) {
      return res.status(400).json({ error: "Brak csvData lub accountId" });
    }

    const result = await withActual(async () => {
      // n8n zazwyczaj radzi sobie z kodowaniem, więc parsujemy bezpośrednio string
      const records = parse(csvData, {
        columns: true,
        skip_empty_lines: true,
        delimiter: ';'
      });

      const transactions = records.map(row => {
        const rawAmount = row['Kwota operacji'].replace(',', '.').replace(/\s/g, '');
        const amount = Math.round(parseFloat(rawAmount) * 100);
        const payeeName = row['Nadawca / Odbiorca'];

        let tx = {
          account: accountId,
          date: row['Data księgowania'].split('.').reverse().join('-'),
          amount: amount,
          notes: row['Tytułem'],
          imported_id: row['Numer referencyjny'],
          cleared: true
        };

        if (accountMapping && accountMapping[payeeName]) {
          tx.payee_name = `Transfer to ${accountMapping[payeeName].name}`;
        } else {
          tx.payee_name = payeeName;
          tx.category = (categoryMapping && categoryMapping[payeeName]) || null;
        }
        return tx;
      });

      return await api.importTransactions(accountId, transactions);
    });

    res.json({ success: true, result });
  } catch (err) {
    console.error('Błąd importu:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serwer nasłuchuje na porcie ${PORT}`);
});
