import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";

const AXONAUT_API_KEY = process.env.AXONAUT_API_KEY;
const MCP_SECRET = process.env.MCP_SECRET; // clé pour sécuriser votre serveur
const BASE_URL = "https://axonaut.com/api/v2";

// --- Fonction utilitaire pour appeler l'API Axonaut ---
async function axonaut(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), {
    headers: { userApiKey: AXONAUT_API_KEY, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Axonaut API error ${res.status}: ${text}`);
  }
  return res.json();
}

// --- Création du serveur MCP ---
const server = new McpServer({ name: "axonaut-mcp", version: "1.0.0" });

// OUTIL 1 : Lister les factures
server.tool(
  "get_invoices",
  "Récupère les factures NEOLITIK depuis Axonaut. Permet de filtrer par statut (paid, unpaid, draft, cancelled) et par période.",
  {
    status: z.enum(["paid", "unpaid", "draft", "cancelled", "all"]).optional().default("all").describe("Statut des factures"),
    start_date: z.string().optional().describe("Date de début (YYYY-MM-DD)"),
    end_date: z.string().optional().describe("Date de fin (YYYY-MM-DD)"),
    limit: z.number().optional().default(50).describe("Nombre maximum de résultats"),
  },
  async ({ status, start_date, end_date, limit }) => {
    const params = { limit };
    if (status !== "all") params.status = status;
    if (start_date) params.start_date = start_date;
    if (end_date) params.end_date = end_date;
    const data = await axonaut("/invoices", params);
    const invoices = Array.isArray(data) ? data : data.invoices || data.data || [];
    const summary = invoices.map((inv) => ({
      id: inv.id,
      numero: inv.number || inv.reference,
      client: inv.company_name || inv.customer_name,
      montant_ht: inv.total_without_taxes,
      montant_ttc: inv.total_with_taxes,
      statut: inv.status,
      date: inv.date,
      date_echeance: inv.due_date,
      paye: inv.paid_amount,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify({ total: invoices.length, factures: summary }, null, 2) }],
    };
  }
);

// OUTIL 2 : Lister les dépenses
server.tool(
  "get_expenses",
  "Récupère les dépenses (achats, frais) de NEOLITIK depuis Axonaut.",
  {
    start_date: z.string().optional().describe("Date de début (YYYY-MM-DD)"),
    end_date: z.string().optional().describe("Date de fin (YYYY-MM-DD)"),
    limit: z.number().optional().default(50).describe("Nombre maximum de résultats"),
  },
  async ({ start_date, end_date, limit }) => {
    const params = { limit };
    if (start_date) params.start_date = start_date;
    if (end_date) params.end_date = end_date;
    const data = await axonaut("/expenses", params);
    const expenses = Array.isArray(data) ? data : data.expenses || data.data || [];
    const summary = expenses.map((exp) => ({
      id: exp.id,
      libelle: exp.label || exp.description,
      fournisseur: exp.company_name || exp.supplier_name,
      montant_ht: exp.total_without_taxes,
      montant_ttc: exp.total_with_taxes,
      categorie: exp.category,
      date: exp.date,
      paye: exp.paid,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify({ total: expenses.length, depenses: summary }, null, 2) }],
    };
  }
);

// OUTIL 3 : Rapprochement bancaire / transactions
server.tool(
  "get_bank_transactions",
  "Récupère les transactions bancaires de NEOLITIK depuis Axonaut (rapprochement bancaire).",
  {
    start_date: z.string().optional().describe("Date de début (YYYY-MM-DD)"),
    end_date: z.string().optional().describe("Date de fin (YYYY-MM-DD)"),
    limit: z.number().optional().default(100).describe("Nombre maximum de résultats"),
  },
  async ({ start_date, end_date, limit }) => {
    const params = { limit };
    if (start_date) params.start_date = start_date;
    if (end_date) params.end_date = end_date;
    const data = await axonaut("/bank-transactions", params);
    const transactions = Array.isArray(data) ? data : data.transactions || data.data || [];
    const summary = transactions.map((t) => ({
      id: t.id,
      libelle: t.label || t.description,
      montant: t.amount,
      date: t.date,
      type: t.amount >= 0 ? "crédit" : "débit",
      rapproche: t.reconciled || t.matched,
    }));
    const total_credits = summary.filter(t => t.montant > 0).reduce((s, t) => s + t.montant, 0);
    const total_debits = summary.filter(t => t.montant < 0).reduce((s, t) => s + t.montant, 0);
    return {
      content: [{
        type: "text", text: JSON.stringify({
          total: transactions.length,
          total_credits: total_credits.toFixed(2),
          total_debits: total_debits.toFixed(2),
          solde_periode: (total_credits + total_debits).toFixed(2),
          transactions: summary
        }, null, 2)
      }],
    };
  }
);

// OUTIL 4 : Tableau de bord financier (synthèse)
server.tool(
  "get_financial_dashboard",
  "Génère un tableau de bord financier synthétique pour NEOLITIK : CA, dépenses, impayés, et solde de trésorerie sur une période donnée.",
  {
    year: z.number().optional().default(new Date().getFullYear()).describe("Année (ex: 2025)"),
  },
  async ({ year }) => {
    const start_date = `${year}-01-01`;
    const end_date = `${year}-12-31`;

    const [invoicesData, expensesData] = await Promise.all([
      axonaut("/invoices", { start_date, end_date, limit: 500 }),
      axonaut("/expenses", { start_date, end_date, limit: 500 }),
    ]);

    const invoices = Array.isArray(invoicesData) ? invoicesData : invoicesData.invoices || invoicesData.data || [];
    const expenses = Array.isArray(expensesData) ? expensesData : expensesData.expenses || expensesData.data || [];

    const ca_total = invoices.filter(i => i.status !== "cancelled" && i.status !== "draft")
      .reduce((s, i) => s + (parseFloat(i.total_without_taxes) || 0), 0);
    const ca_encaisse = invoices.filter(i => i.status === "paid")
      .reduce((s, i) => s + (parseFloat(i.total_with_taxes) || 0), 0);
    const impayes = invoices.filter(i => i.status === "unpaid")
      .reduce((s, i) => s + (parseFloat(i.total_with_taxes) || 0), 0);
    const nb_impayes = invoices.filter(i => i.status === "unpaid").length;
    const total_depenses_ht = expenses.reduce((s, e) => s + (parseFloat(e.total_without_taxes) || 0), 0);

    // CA par mois
    const ca_par_mois = {};
    for (let m = 1; m <= 12; m++) ca_par_mois[m] = 0;
    invoices.filter(i => i.status !== "cancelled" && i.status !== "draft" && i.date).forEach(inv => {
      const mois = new Date(inv.date).getMonth() + 1;
      ca_par_mois[mois] += parseFloat(inv.total_without_taxes) || 0;
    });

    return {
      content: [{
        type: "text", text: JSON.stringify({
          annee: year,
          chiffre_affaires: {
            total_ht: ca_total.toFixed(2),
            encaisse_ttc: ca_encaisse.toFixed(2),
            impayes_ttc: impayes.toFixed(2),
            nb_factures_impayees: nb_impayes,
          },
          depenses: {
            total_ht: total_depenses_ht.toFixed(2),
            nb_depenses: expenses.length,
          },
          marge_brute_estimee_ht: (ca_total - total_depenses_ht).toFixed(2),
          ca_mensuel_ht: Object.fromEntries(
            Object.entries(ca_par_mois).map(([m, v]) => [
              new Date(year, m - 1).toLocaleString("fr-FR", { month: "long" }),
              v.toFixed(2)
            ])
          ),
        }, null, 2)
      }],
    };
  }
);

// OUTIL 5 : Devis en cours
server.tool(
  "get_quotations",
  "Récupère les devis de NEOLITIK (en cours, acceptés, refusés).",
  {
    status: z.enum(["pending", "accepted", "refused", "all"]).optional().default("all"),
    limit: z.number().optional().default(50),
  },
  async ({ status, limit }) => {
    const params = { limit };
    if (status !== "all") params.status = status;
    const data = await axonaut("/quotations", params);
    const quotations = Array.isArray(data) ? data : data.quotations || data.data || [];
    const summary = quotations.map((q) => ({
      id: q.id,
      numero: q.number || q.reference,
      client: q.company_name || q.customer_name,
      montant_ht: q.total_without_taxes,
      statut: q.status,
      date: q.date,
      date_validite: q.expiry_date,
    }));
    const pipeline = summary.filter(q => q.statut === "pending")
      .reduce((s, q) => s + (parseFloat(q.montant_ht) || 0), 0);
    return {
      content: [{
        type: "text", text: JSON.stringify({
          total: quotations.length,
          pipeline_en_cours_ht: pipeline.toFixed(2),
          devis: summary
        }, null, 2)
      }],
    };
  }
);

// --- Serveur HTTP Express ---
const app = express();
app.use(express.json());

// Route de santé — AVANT le middleware d'auth (pas besoin de secret pour vérifier que le serveur tourne)
app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "axonaut-mcp", timestamp: new Date().toISOString() });
});

// Middleware d'authentification : accepte le secret via header Authorization OU via ?secret= dans l'URL
app.use((req, res, next) => {
  if (!MCP_SECRET) return next(); // pas de secret configuré = accès libre (dev uniquement)
  const authHeader = req.headers.authorization;
  const authQuery = req.query.secret;
  if (authHeader === `Bearer ${MCP_SECRET}` || authQuery === MCP_SECRET) return next();
  res.status(401).json({ error: "Non autorisé" });
});

// Route MCP principale
app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Serveur MCP Axonaut démarré sur le port ${PORT}`);
  if (!AXONAUT_API_KEY) console.warn("⚠️  AXONAUT_API_KEY non définie !");
  if (!MCP_SECRET) console.warn("⚠️  MCP_SECRET non définie — serveur non sécurisé !");
});
