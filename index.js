const express = require('express');
const { parse } = require('csv-parse/sync');
const api = require('@actual-app/api');
const swaggerUi = require('swagger-ui-express');
const swaggerDefinition = require('./swaggerDef');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 5008;

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDefinition));

/**
 * Helper do inicjalizacji połączenia z Actual Budget
 */
async function withActual(fn) {
  try {
    await api.init({
      serverURL: process.env.ACTUAL_SERVER_URL || 'http://localhost:5006',
      password: process.env.ACTUAL_PASSWORD,
      dataDir: './actual-data',
      verbose: false
    });
    if (!process.env.ACTUAL_SYNC_ID) throw new Error("Brak ACTUAL_SYNC_ID");
    await api.downloadBudget(process.env.ACTUAL_SYNC_ID);
    return await fn();
  } finally {
    try { await api.shutdown(); } catch (err) { }
  }
}

// --- ENDPOINT: POBIERANIE KONT ---
app.get('/accounts', async (req, res) => {
  try {
    const accounts = await withActual(async () => {
      return await api.getAccounts();
    });
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ENDPOINT: POBIERANIE KATEGORII ---
app.get('/categories', async (req, res) => {
  try {
    const categories = await withActual(async () => {
      return await api.getCategories();
    });
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Zbuduj mapę "GroupName/CategoryName" -> categoryId
async function buildCategoryLookup() {
  const groups = await api.getCategoryGroups();
  const lookup = {};
  for (const group of groups) {
    for (const cat of group.categories || []) {
      lookup[`${group.name}/${cat.name}`] = cat.id;
    }
  }
  return lookup;
}


app.post('/import', async (req, res) => {
  try {
    const { csvData, accountId, categoryMapping, accountMapping } = req.body;
    if (!csvData || !accountId) {
      return res.status(400).json({ error: "Brak csvData lub accountId" });
    }

    const result = await withActual(async () => {
      const records = parse(csvData, {
        columns: true,
        skip_empty_lines: true,
        delimiter: ';'
      });

      // Pobierz payees i kategorie raz
      const allPayees = await api.getPayees();
      const categoryGroups = await api.getCategoryGroups();

      // Mapa: actualAccountId -> transfer payee ID
      const transferPayeeByAccountId = {};
      for (const payee of allPayees) {
        if (payee.transfer_acct) {
          transferPayeeByAccountId[payee.transfer_acct] = payee.id;
        }
      }

      // Mapa: "GroupName/CategoryName" -> categoryId
      const categoryLookup = {};
      for (const group of categoryGroups) {
        for (const cat of group.categories || []) {
          categoryLookup[`${group.name}/${cat.name}`] = cat.id;
        }
      }

      // Mapa: payee name (lowercase) -> payee ID
      const payeeLookup = {};
      for (const payee of allPayees) {
        if (payee.name) {
          payeeLookup[payee.name.toLowerCase()] = payee.id;
        }
      }

      console.log("Transfer payees by account ID:", transferPayeeByAccountId);
      console.log("Category lookup:", categoryLookup);
      console.log("Account Mapping:", accountMapping);
      console.log("Category Mapping:", categoryMapping);

      const transactions = records.map(row => {
        const rawAmount = row['Kwota operacji']
          ? row['Kwota operacji'].replace(',', '.').replace(/\s/g, '')
          : '0';
        const amount = Math.round(parseFloat(rawAmount) * 100);

        const payeeName = row['Nadawca / Odbiorca'] || '';
        const incomingAccountNumber = row['Rachunek źródłowy']
          ? row['Rachunek źródłowy'].replace(/\s/g, '').replace("'", "")
          : '';
        const targetAccountNumber = row['Rachunek docelowy']
          ? row['Rachunek docelowy'].replace(/\s/g, '').replace("'", "")
          : '';
        const title = row['Tytułem'] || '';

        let tx = {
          account: accountId,
          date: row['Data księgowania']
            ? row['Data księgowania'].split('.').reverse().join('-')
            : new Date().toISOString().split('T')[0],
          amount: amount,
          notes: title,
          imported_id: row['Numer referencyjny'],
          cleared: false,
        };

        // 1. Logika transferów
        const targetActualId =
          targetAccountNumber && accountMapping?.[targetAccountNumber]?.id;
        const incomingActualId =
          incomingAccountNumber && accountMapping?.[incomingAccountNumber]?.id;

        if (targetActualId && transferPayeeByAccountId[targetActualId]) {
          tx.payee = transferPayeeByAccountId[targetActualId];
          tx.category = null;
        } else if (incomingActualId && transferPayeeByAccountId[incomingActualId]) {
          tx.payee = transferPayeeByAccountId[incomingActualId];
          tx.category = null;
        } else {
          // 2. Zwykła transakcja — dopasowanie kategorii po nazwie
          tx.payee_name = payeeName;
          tx.category = null;

          if (categoryMapping) {
            const searchString = (payeeName + ' ' + title).toLowerCase();
            const matchedKey = Object.keys(categoryMapping).find(key =>
              searchString.includes(key.toLowerCase())
            );

            if (matchedKey) {
              const categoryPath = categoryMapping[matchedKey];
              tx.category = categoryLookup[categoryPath] ?? null;

              if (!tx.category) {
                console.warn(`Nie znaleziono kategorii dla ścieżki: "${categoryPath}"`);
              }
            }
          }
        }

        console.log('Przetwarzana transakcja:', tx);
        return tx;
      });

      // Import transakcji
      const importResult = await api.importTransactions(accountId, transactions);
      const addedIds = new Set(importResult.added);

      // Pobierz istniejące transakcje z całego zakresu dat jednym zapytaniem
      const dates = transactions.map(t => t.date).sort();
      const allExisting = await api.getTransactions(accountId, dates[0], dates[dates.length - 1]);

      const existingByImportedId = {};
      for (const e of allExisting) {
        if (e.imported_id) existingByImportedId[e.imported_id] = e;
      }

      // Zaktualizuj transakcje które już istniały i nie są cleared
      for (const tx of transactions) {
        if (!tx.imported_id) continue;

        const match = existingByImportedId[tx.imported_id];
        if (!match || addedIds.has(match.id) || match.cleared) continue;

        const updates = {};

        if (tx.payee) {
          updates.payee = tx.payee;  // było: payee_id
          updates.category = null;
        } else {
          if (tx.payee_name) {
            const resolvedPayeeId = payeeLookup[tx.payee_name.toLowerCase()];
            if (resolvedPayeeId) {
              updates.payee = resolvedPayeeId;  // było: payee_id
            }
          }
          if (tx.category !== undefined) {
            updates.category = tx.category;
          }
        }

        console.log(`Aktualizuję transakcję ${match.id}:`, updates);
        await api.updateTransaction(match.id, updates);
      }

      return importResult;
    });

    res.json({ success: true, result });
  } catch (err) {
    console.error('Błąd importu:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serwer gotowy na porcie ${PORT}`);
});
