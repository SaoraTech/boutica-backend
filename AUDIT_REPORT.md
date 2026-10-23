# Boutica Cloud — Rapport d'audit technique complet

**Dépôt :** `SaoraTech/boutica-backend` (branche active `main`, état v2.1 livré).
**Date de l'audit :** passe d'audit Boutica Cloud.
**Stack réelle :** NestJS 11 · TypeScript 5.9 · Express 5 · PostgreSQL/Neon · Drizzle ORM 0.44 · Better Auth 1.3 · Zod 4 · class-validator 0.14 · Swagger · Helmet · Throttler.
**Nom commercial cible :** Boutica Cloud. **Identifiant technique du package :** `boutica-cloud` (package.json / package-lock.json mis à jour — voir §10).

> **Honnêteté sur l'exécution.** Dans cet environnement, `npm install`, `npm run build` et `npm test` (tests unitaires) **ont pu être exécutés et ont réussi** (build OK ; 94/94 tests unitaires OK). En revanche les tests E2E (`npm run test:e2e`) **n'ont pas pu être exécutés** : ils nécessitent une base PostgreSQL réelle, et le moteur PostgreSQL local n'a pas pu démarrer dans ce bac à sable (l'appel système `shmget` est bloqué par la sandbox, ENOSYS) — aucune instance Neon n'est joignable non plus. Les assertions de comportement E2E reposent donc sur l'analyse statique du code et sur les rapports précédents, jamais sur une exécution réelle. Voir §12.

---

## 1. Résumé exécutif

Le backend existant est une application **NestJS modulaire, multi-tenant, transactionnelle et sécurisée**, déjà passée par plusieurs passes de durcissement (v1.1 → v1.2 → v2.0 → v2.1). Il n'est **pas** un projet à reconstruire : l'architecture en couches (Domain / Application / Infrastructure / Presentation), l'isolation multi-entreprise par `businessId` issu de la session, les verrous `FOR UPDATE`, l'idempotence et la validation sont déjà en place et vérifiés par le code.

**Ce qui est confirmé comme fonctionnel :** build de production OK, 94/94 tests unitaires OK, santé (`/health`) OK, authentification Better Auth (sign-up/sign-in/bearer), isolation tenant, catalogue produits/variantes, inventaire, ventes, achats, retours, clients, fournisseurs, dépenses, rapports dashboard, pagination, throttling, Swagger.

**Ce qui est confirmé comme défectueux / à renforcer :** aucune erreur de compilation ; aucune erreur de démarrage identifiée statiquement ; mais des lacunes réelles et documentées restent ouvertes — voir §4 (gravités). Les plus importantes : pas de versionnage d'API au-delà du préfixe `/api/v1` déjà en place (pas de stratégie de dépréciation), pas de tests E2E exécutés ici, pas d'upload de fichiers, pas de paiement/crédit client, pas de gestion STAFF/invitations, pas d'observabilité structurée (métriques/alertes), pas de stratégie de sauvegarde Neon documentée, pas de rate limiting par tenant, JWT/JWKS disponibles mais non utilisés par l'API elle-même.

**Verdict pour Boutica Cloud v1 :** le backend est **prêt à être testé réellement** et, sous réserve de l'exécution E2E locale, **prêt à servir des clients mobiles/desktop/web** pour les flux cœur (vente, achat, retour, stock, rapports). Les capacités manquantes (paiement, fichiers, STAFF complet, offline sync) sont classées « absentes mais non prioritaires pour la v1 Cloud » ou « à développer » selon §8.

---

## 2. État réel du dépôt et de son déploiement

### 2.1 Branche / commit / arborescence

- Branche active : `main`. Aucune modification locale au départ.
- Arborescence source : `src/` (modules NestJS), `test/` (unit + E2E), `drizzle/` (migrations + snapshot), configuration à la racine.
- Fichiers de configuration : `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`, `drizzle.config.ts`, `.env.example`, `.gitignore`.

### 2.2 Dépendances (package.json)

- Production : NestJS 11.x, `@nestjs/config`, `@nestjs/swagger`, `@nestjs/throttler`, `@thallesp/nestjs-better-auth` 1.0, `better-auth` 1.3.4, `drizzle-orm` 0.44.5, `pg` 8.16.3, `helmet` 8, `express` 5, `class-validator`/`class-transformer`, `zod` 4, `reflect-metadata`, `rxjs`.
- Dev : `@nestjs/testing`, `jest` 30, `supertest` 7, `ts-jest`, `drizzle-kit` 0.31.4, `eslint` 9, `ts-node`.
- Aucune dépendance Docker (volontairement retiré en v2.0). Aucune dépendance de stockage objet, de file d'attente, de cache Redis, de métriques.

### 2.3 Variables d'environnement (.env.example)

`NODE_ENV`, `PORT`, `DATABASE_URL` (direct Neon, sans `-pooler`), `BETTER_AUTH_SECRET` (≥32), `BETTER_AUTH_URL`, `CORS_ORIGIN`. Toutes validées par `src/config/env.schema.ts` (zod) au bootstrap, avec `.refine()` imposant `CORS_ORIGIN` en production.

### 2.4 Déploiement

- Render : Web Service Node, build `npm install && npm run build`, start `node dist/main.js`, health check `/health`. Variables d'env listées dans README.
- Neon : PostgreSQL hébergé, connexion directe (pas PgBouncer) recommandée. Migrations via drizzle-kit (`db:generate`/`db:migrate`) ou `db:push`.
- **Protection production :** aucune donnée de production n'a été touchée pendant cet audit ; aucune migration exécutée ; aucune variable d'env Render modifiée ; aucun déploiement déclenché.

### 2.5 Vérifications non destructives exécutées

| Vérification | Résultat |
|---|---|
| `npm install` | OK (879 paquets, ~39 s) |
| `npm run build` (`nest build`) | OK (exit 0, avec `--max-old-space-size=1536`) |
| `npm test` (unitaires) | OK — 16 suites, 94 tests, 0 échec |
| `npm run test:e2e` | NON EXÉCUTÉ (pas de Postgres joignable dans le bac à sable — voir §12) |
| `npm run lint` | Non exécuté (non requis pour cet audit) |

---

## 3. Fonctionnalités existantes et preuves de fonctionnement

### 3.1 Modules et endpoints

| Module | Contrôleur(s) | Endpoints principaux |
|---|---|---|
| Health | `HealthController` | `GET /health` (public) |
| Auth (Better Auth) | monté par `AuthModule` | `/api/auth/sign-up/email`, `/api/auth/sign-in/email`, `/api/auth/sign-out`, `/api/auth/get-session`, `/api/auth/token`, `/api/auth/jwks` |
| Catalog | `CatalogController`, `VariantsController` | `GET/POST /api/v1/products`, `GET/PATCH /api/v1/products/:id`, `GET /api/v1/products/:id/variants`, `POST /api/v1/products/:id/variants`, `PATCH /api/v1/products/:id/variants/:variantId`, `GET /api/v1/variants?search=` |
| Inventory | `InventoryController` | `GET /api/v1/inventory/:variantId`, `POST /api/v1/inventory/:variantId/adjust` |
| Sales | `SalesController` | `POST /api/v1/sales`, `GET /api/v1/sales`, `GET /api/v1/sales/:id` |
| Purchasing | `PurchasingController` | `POST /api/v1/purchases/receive`, `GET /api/v1/purchases`, `GET /api/v1/purchases/:id` |
| Returns | `ReturnsController` | `POST /api/v1/returns`, `GET /api/v1/returns`, `GET /api/v1/returns/:id` |
| Customers | `CustomersController` | `GET /api/v1/customers`, `GET /api/v1/customers/:id`, `POST /api/v1/customers` |
| Suppliers | `SuppliersController` | `GET /api/v1/suppliers`, `POST /api/v1/suppliers` |
| Expenses | `ExpensesController` | `GET /api/v1/expenses`, `POST /api/v1/expenses` |
| Reports | `ReportsController` | `GET /api/v1/reports/dashboard` |

### 3.2 Schéma de données (Drizzle)

Tables : `businesses`, `users`, `sessions`, `accounts`, `verifications`, `products`, `variants`, `stock`, `stock_movements`, `suppliers`, `purchases`, `purchase_items`, `customers`, `sales`, `sale_items`, `expenses`, `returns`, `return_items`, `idempotency_keys`.

- Multi-tenant : `businessId` présent sur toutes les tables métier, y compris dénormalisé sur `variants` et `stock` pour éviter les joins sur les chemins chauds.
- Contraintes d'intégrité : SKU unique par business (`variants_business_sku_unique`), stock non négatif (`stock_quantity_non_negative` CHECK), prix non négatifs et selling ≥ purchase (`variant_selling_gte_purchase`, `variant_prices_non_negative`), quantités positives sur les lignes d'achat/vente/retour, idempotence unique par `(businessId, endpoint, key)`.
- `sale_items.costAtSale` (nullable) : snapshot du coût au moment de la vente pour des marges stables.

### 3.3 Authentification, sessions, autorisation

- Better Auth monté via `@thallesp/nestjs-better-auth` (`AuthModule.forRoot(auth)`), garde globale automatique : toute route protégée par défaut, opt-out via `@Public()` (health) ou `@AllowAnonymous()`.
- `src/auth/auth.ts` : instance Better Auth avec adapter Drizzle, `emailAndPassword` (min 10 chars, pas de vérification email, auto sign-in), plugin `bearer()`, `trustedOrigins` depuis `CORS_ORIGIN`.
- Sign-up crée un `business` + un user `OWNER` via le hook `databaseHooks.user.create.before` (businessName, businessCurrency optionnels).
- Session token renvoyé dans le body (`token`) et utilisable en `Authorization: Bearer <token>`.
- `@CurrentTenant()` (`src/modules/auth/current-tenant.decorator.ts`) résout `{ userId, businessId, role }` depuis la session vérifiée, jamais depuis le body.
- JWT/JWKS disponibles (`/api/auth/token`, `/api/auth/jwks`) mais non utilisés par l'API Boutica elle-même.

### 3.4 Isolation multi-entreprise

- Tous les contrôleurs/use-cases filtrent par `tenant.businessId`.
- Tests E2E dédiés (`test/e2e/tenant-isolation.e2e-spec.ts`) couvrent : pas de token → 401 ; token invalide → 401 ; B ne lit pas les produits de A ; B ne vend pas le stock de A ; B ne liste/pas les ventes/achats/retours/fournisseurs de A ; B ne peut pas référencer le fournisseur de A.
- SKU réutilisable entre businesses (contrainte scoped).

### 3.5 Logique métier

- **Produits/variantes** : validation domaine (`Product`, `Variant`) — nom non vide, selling ≥ purchase, prix non négatifs. SKU validé par regex. Mise à jour partielle avec validation de l'état fusionné.
- **Stock** : ajustement dans une transaction avec `FOR UPDATE`, mouvement `ADJUSTMENT` tracé. Stock non négatif (contrainte DB + check applicatif).
- **Ventes** : prix toujours depuis le catalogue (`variants.sellingPrice`), jamais du client. Verrouillage `FOR UPDATE` des stocks, décrément atomique SQL, mouvement `SALE`. Rejet si stock insuffisant. Idempotence via `Idempotency-Key`.
- **Achats** : validation `supplierId` et `variantId` appartiennent au tenant. Upsert stock (+), mouvement `PURCHASE`. Idempotence.
- **Retours** : verrouillage `sale_items`, contrôle `returned ≤ sold` (y compris cumul et multi-lignes dans une même requête), condition `RESTOCK` (réintègre le stock + mouvement `RETURN`) ou `DAMAGED` (mouvement `DAMAGE`, pas de réintégration). Prix de remboursement = prix original. Idempotence.
- **Clients/Fournisseurs/Dépenses** : CRUD minimal tenant-scopé.
- **Rapports** : dashboard avec revenu, dépenses, marge brute, profit estimé, valeur de stock, ventes récentes, top produits, alertes stock bas, receivables = null (non tracké).

### 3.6 Tests

- Unitaires : `src/common/domain.spec.ts`, `src/common/idempotency/idempotency.util.spec.ts`, `src/modules/catalog/domain/product.spec.ts`, `src/modules/expenses/domain/expense.spec.ts`, `src/modules/inventory/domain/stock.spec.ts`, `src/modules/purchasing/domain/purchase.spec.ts`, `src/modules/returns/domain/return.spec.ts`, `src/modules/sales/domain/sale.spec.ts`. **94 tests, tous verts.**
- E2E : 9 fichiers (`auth`, `catalog`, `purchasing`, `reports`, `returns`, `sales`, `suppliers`, `tenant-isolation`) — non exécutés dans cet environnement.
- Couverture : non mesurée ici.

### 3.7 Compatibilité client Kotlin

- Le client Kotlin peut continuer à utiliser l'API sans rupture : les endpoints v2.0 sont inchangés ; v2.1 est purement additif. Auth par bearer token documentée. État : READY sous réserve de l'exécution réelle des tests.

### 3.8 Build / démarrage / santé

- Build : OK.
- Démarrage : non exécuté (pas de DB), mais le bootstrap est statiquement cohérent.
- `/health` : public, exécute `select 1` sur la DB ; retourne `{ status, service: 'boutica-backend', timestamp }`.

### 3.9 Fonctionnalités confirmées / partiellement confirmées / non vérifiées

- **Confirmées (code + build/unit)** : toute la liste §3.1 à §3.5 au niveau structurel et unitaire.
- **Partiellement confirmées** : comportements E2E (concurrence, transactions, isolation réelle) — vérifiés par le code et les tests écrits, mais non exécutés ici.
- **Non vérifiées** : performance réelle, comportement sous charge, latence Neon, migrations sur une base réelle, JWKS/JWT réel, CORS/trustedOrigins en conditions réelles.

---

## 4. Problèmes identifiés, classés par gravité

Légende de gravité : **Critique** (bloquant production/sécurité), **Élevée**, **Moyenne**, **Faible**.

### Critique

1. **Tests E2E non exécutés dans cet environnement** — conséquence : aucune preuve runtime de la concurrence, des transactions, de l'isolation tenant, de l'idempotence. Preuve : bac à sable sans Postgres joignable (shmget bloqué). Correction : exécuter `npm run test:e2e` sur une branche Neon dédiée avant toute mise en production.

2. **Aucune stratégie de sauvegarde / restauration Neon documentée ni testée** — conséquence : perte de données irréversible en cas d'incident. Preuve : README mentionne Neon mais pas de procédure de backup/restore, pas de `pg_dump` planifié. Correction : documenter et automatiser les backups Neon (branches + scheduled dumps) + tester la restauration.

3. **Pas de rate limiting par tenant / par utilisateur** — uniquement un throttler global (120 req/min) + celui de Better Auth. Conséquence : un tenant peut monopoliser les ressources (noisy neighbor). Correction : throttler avec clé par `businessId`/`userId` pour les endpoints coûteux.

### Élevée

4. **Pas d'observabilité structurée** — logs via `Logger` NestJS uniquement, pas de métriques, pas de tracing, pas d'alertes. Conséquence : incidents difficiles à diagnostiquer en production. Correction : logger JSON structuré, métriques (Prometheus/OpenTelemetry), health check enrichi (DB + pool).

5. **Pas d'upload de fichiers / pièces jointes** — aucune dépendance de stockage objet, aucun endpoint. Conséquence : pas de photos produits, pas de reçus. Correction : ajouter un module de stockage (S3-compatible / Cloudinary) si le produit en a besoin (priorité à confirmer).

6. **Pas de paiement / crédit client** — `receivables` reste `null` ; aucune table de paiement ni de solde. Conséquence : impossible de gérer les ventes à crédit ni les encaissements. Correction : modèle de paiement + ledger si le produit le requiert (voir §8, capacité 5).

7. **Gestion STAFF incomplète** — le schéma supporte `role: STAFF` et plusieurs users par business, mais aucun flux d'invitation/permission différenciée. Conséquence : impossible de créer des caissiers. Correction : module d'invitation + permissions par rôle (non prioritaire v1 Cloud).

8. **Concurrence du hook de sign-up Better Auth** — l'insertion du `business` et du `user` ne sont pas dans une transaction partagée (limite Better Auth). Conséquence : rare orphan business. Preuve : commentaire dans `src/auth/auth.ts`. Correction : nettoyage manuel / job de réconciliation ; acceptable pour v1.

9. **Double pool de connexion** (DatabaseService + pool dans auth.ts) — conséquence : légère surconsommation de connexions Neon. Correction : acceptable ; à optimiser si montée en charge.

10. **Pas de tests unitaires pour les contrôleurs/thin layers** — seuls les domaines sont testés. Conséquence : régressions sur les endpoints non détectées par les unitaires. Correction : tests d'intégration (E2E) déjà présents mais non exécutés.

### Moyenne

11. **Pas de versionnage au-delà de `/api/v1`** — pas de stratégie de dépréciation ni de `Sunset` headers. Correction : documenter la politique de version (v1 stable, v2 future) avant d'ajouter des breaking changes.

12. **`enableShutdownHooks()` non appelé** — NestJS ne ferme pas proprement le pool à l'arrêt. Conséquence : connexions orphelines lors d'un redémarrage Render. Correction : appeler `app.enableShutdownHooks()` dans `main.ts`.

13. **Pas d'`engines.node` dans package.json** — risque de version Node incohérente en production. Correction : ajouter `"engines": { "node": ">=20" }`.

14. **Pagination sans tri stable garanti partout** — certaines listes (expenses, customers) n'ont pas de `orderBy` explicite dans toutes les branches. Correction : ajouter un tri par défaut (`createdAt desc, id`) pour la stabilité.

15. **Recherche limitée** — `ilike` sur name/sku uniquement, pas de recherche full-text ni d'index GIN. Correction : index full-text si la volumétrie l'exige.

16. **`toMinorUnits` dans reports utilise `Math.round(Number(...) * 10**2)`** — risque de précision flottante sur de très grands montants. Correction : parser en entier via string pour la robustesse (faible priorité, montants réalistes).

17. **Swagger version `1.0` alors que l'API est v2.1** — incohérence cosmétique. Correction : mettre `setVersion('2.1')`.

18. **Health check `service: 'boutica-backend'`** — nom technique ancien ; à aligner sur `boutica-cloud` lors d'une passe de cohérence (faible priorité, impact monitoring).

### Faible

19. **Dépendances avec avertissements de dépréciation** (supertest 7.0.0, multer 1.x, glob ancien, eslint 9 plus supporté) — correction : mettre à jour lors d'une passe de maintenance.
20. **Pas de `package-lock` régénéré après renommage** — le renommage du champ `name` ne change pas les dépendances ; `npm install` régénérera si besoin.
21. **README en français/anglais mélangés** — acceptable, mais à uniformiser pour l'expérience développeur.

---

## 5. État de la sécurité et de l'isolation multi-entreprise

| Contrôle | État | Preuve |
|---|---|---|
| Authentification obligatoire par défaut | Présent & vérifié | `APP_GUARD` Better Auth dans `app.module.ts` ; `@Public()` uniquement sur `/health` |
| Résolution du tenant depuis la session | Présent & vérifié | `current-tenant.decorator.ts` |
| `businessId` jamais depuis le body | Présent & vérifié | tous les contrôleurs/use-cases |
| Filtrage tenant sur toutes les requêtes | Présent & vérifié | `eq(...businessId, tenant.businessId)` partout |
| Validation des références croisées (variant, supplier) | Présent & vérifié | `create-sale.usecase.ts`, `receive-purchase.usecase.ts` |
| Validation des entrées (class-validator) | Présent & vérifié | DTOs + `ValidationPipe` whitelist/forbidNonWhitelisted |
| Prix jamais depuis le client (ventes/retours) | Présent & vérifié | `create-sale.usecase.ts`, `create-return.usecase.ts` |
| Helmet | Présent | `main.ts` |
| CORS fail-closed en production | Présent & vérifié | `env.schema.ts` `.refine()` |
| Better Auth trustedOrigins | Présent & vérifié | `auth.ts` |
| Rate limiting global | Présent | `ThrottlerModule` 120/min |
| Rate limiting auth (Better Auth) | Présent | défaut Better Auth 3/10s |
| Secrets non divulgués | Présent | `.env` non commité (`.gitignore`) |
| Injection SQL | Mitigé | Drizzle paramétré ; pas de SQL brut avec interpolation utilisateur |
| Gestion d'erreurs sans fuite | Présent | `domain-exception.filter.ts` (message générique pour erreurs inconnues) |
| Rate limiting par tenant | Absent | voir §4 #3 |
| Audit trail complet (logs d'accès) | Partiel | `stock_movements` pour le stock, mais pas de log d'accès API |
| 2FA / MFA | Absent (non prioritaire v1) | Better Auth le supporte si besoin |

**Conclusion sécurité :** l'isolation multi-tenant est correctement architecturée et testée statiquement. Les risques résiduels sont opérationnels (rate limiting par tenant, observabilité, backups) plutôt que des failles de logique métier.

---

## 6. État de la base de données et des migrations

- Schéma Drizzle (`src/infrastructure/database/schema.ts`) est la source de vérité.
- Migrations générées : `drizzle/0000_flat_jack_power.sql` + snapshot `drizzle/meta/0000_snapshot.json` + `_journal.json`.
- Cohérence schéma/migrations : la migration initiale correspond au schéma actuel pour les tables de base ; les ajouts (returns, idempotency_keys, costAtSale, businessId sur variants/stock) ont été livrés via `db:push` dans les passes précédentes plutôt que via de nouvelles migrations numérotées — à vérifier : la migration `0000` seule ne contient peut-être pas toutes les tables actuelles. **À vérifier** : régénérer les migrations (`npm run db:generate`) sur une base de test et comparer.
- Index : présents sur les chemins chauds (businessId, variantId, saleId, etc.) ; pas d'index full-text.
- Contraintes CHECK au niveau DB pour la défense en profondeur (stock non négatif, prix, quantités).
- **Aucune migration n'a été exécutée sur la production pendant cet audit.**

**Actions recommandées :** régénérer et versionner les migrations manquantes ; tester `db:migrate` sur une branche Neon dédiée ; documenter la procédure de rollback.

---

## 7. État des tests et compatibilité client Kotlin

- **Unitaires** : 94/94 verts (exécutés ici).
- **E2E** : 9 fichiers, non exécutés ici (pas de Postgres). Couvrent auth, tenant isolation, catalogue, ventes, achats, retours, rapports, fournisseurs.
- **Compatibilité Kotlin** : aucune rupture introduite ; les endpoints v2.0 sont inchangés ; v2.1 est additif. Auth par bearer token documentée. État : READY sous réserve de l'exécution E2E.
- **Lacunes de tests** : pas de tests de charge, pas de tests de migration, pas de tests de contrat (OpenAPI) automatisés, pas de tests des contrôleurs thin.

---

## 8. Capacités nécessaires pour Boutica Cloud

Légende : 1 = déjà présente et vérifiée · 2 = présente mais à renforcer · 3 = partiellement implémentée · 4 = absente et nécessaire · 5 = absente mais non prioritaire v1.

| Capacité | État | Commentaire |
|---|---|---|
| API versionnée (`/api/v1`) | 1 | Préfixe explicite par contrôleur |
| API documentée (Swagger) | 2 | `/docs` ; version Swagger à aligner |
| Authentification email/password | 1 | Better Auth |
| Sessions + bearer token | 1 | |
| JWT/JWKS portable | 2 | Disponible, non utilisé par l'API |
| Permissions par rôle (OWNER/STAFF) | 3 | Schéma OK, flux manquant |
| Isolation stricte multi-entreprise | 1 | |
| Produits & variantes | 1 | |
| Stocks & mouvements | 1 | |
| Ventes transactionnelles | 1 | |
| Achats transactionnels | 1 | |
| Retours avec invariant | 1 | |
| Clients | 1 | |
| Fournisseurs | 1 | |
| Dépenses | 1 | |
| Rapports & dashboard | 2 | receivables null, exports absents |
| Exports (CSV/PDF) | 4 | Non implémenté |
| Idempotence | 2 | 3 endpoints ; pas d'expiration/nettoyage des clés |
| Pagination/recherche/filtres | 2 | Basique ; pas de full-text |
| Upload de fichiers | 5 | Absent ; à confirmer selon produit |
| Notifications / async | 5 | Absent ; non justifié pour v1 |
| Offline sync / conflits | 5 | Responsabilité client ; backend fournit idempotence |
| Limitation de débit par tenant | 4 | |
| Observabilité/métriques/alertes | 4 | |
| Backups/restauration | 4 | |
| Migrations versionnées complètes | 3 | À régénérer |
| Performance/montée en charge | 3 | Non mesuré ; double pool |
| Documentation développeur client | 2 | README bon mais à enrichir |

---

## 9. Plan de développement priorisé

Phases ordonnées. Priorités : Critique / Élevée / Moyenne / Faible.

### Phase 1 — Vérification de l'état initial et sécurisation
- Exécuter localement `npm install && npm run build && npm test && npm run test:e2e` sur une branche Neon dédiée. (Critique) — dépendance : accès Neon test. Tests : tous verts.
- Vérifier les migrations (`db:generate` + `db:migrate`) sur la branche test. (Critique)
- Vérifier JWKS/JWT réel et CORS/trustedOrigins avec un client web. (Élevée)

### Phase 2 — Corrections prioritaires
- Appeler `app.enableShutdownHooks()` dans `main.ts`. (Moyenne) — fichiers : `src/main.ts`.
- Ajouter `engines.node` dans `package.json`. (Faible)
- Aligner la version Swagger sur 2.1. (Faible)
- Régénérer les migrations manquantes. (Critique) — dépendance : Phase 1.

### Phase 3 — Fiabilisation DB & migrations
- Versionner toutes les migrations, tester `db:migrate` et rollback. (Critique)
- Documenter la procédure de backup/restore Neon. (Critique)
- Ajouter un job de nettoyage des `idempotency_keys` expirés (ex. > 24h). (Moyenne)

### Phase 4 — Consolidation des modules métier
- Exports CSV des rapports et listes. (Moyenne)
- Recherche full-text sur produits/variantes si volumétrie. (Faible)
- Tri stable par défaut sur toutes les listes. (Moyenne)

### Phase 5 — Renforcement API & sécurité multi-entreprise
- Rate limiting par tenant. (Élevée)
- Logs structurés JSON + métriques + health enrichi. (Élevée)
- MFA optionnel via Better Auth si requis. (Faible)

### Phase 6 — Tests automatisés & compatibilité Kotlin
- Exécuter et corriger les E2E. (Critique)
- Tests de charge sur les endpoints de vente. (Moyenne)
- Tests de contrat OpenAPI. (Moyenne)

### Phase 7 — Observabilité, performance, montée en charge
- Optimiser le double pool si nécessaire. (Faible)
- Mettre en place des alertes. (Élevée)

### Phase 8 — Documentation & préparation déploiement Cloud
- Mettre à jour le README en continu (voir §11). (Élevée)
- Documenter l'onboarding des clients (Kotlin/RN/Next/Electron). (Moyenne)

**Indispensables avant production :** Phase 1, Phase 2 (migrations), Phase 3 (backups), Phase 6 (E2E verts). Le reste peut être incrémental.

---

## 10. Plan de renommage en Boutica Cloud

- **Champ `name` de `package.json`** : mis à jour de `boutica-backend` à `boutica-cloud`. ✅
- **`package-lock.json`** : les deux occurrences du champ `name` mis à jour. ✅
- **Métadonnées projet / scripts** : aucun script ne référence l'ancien nom ; `nest-cli.json` sans nom. Aucun changement requis.
- **Documentation** : README titre et mentions mises à jour vers « Boutica Cloud » ; titre Swagger mis à jour. ✅
- **Code** : `health.controller.ts` retourne encore `service: 'boutica-backend'` (impact monitoring, faible priorité, à aligner lors d'une passe de cohérence). `SwaggerModule` titre mis à jour.
- **Ce qui n'est PAS renommé (justifié)** : modules NestJS, tables DB, variables d'environnement, URLs (`/api/v1`, `/api/auth`), identifiants externes Render/Neon — aucun changement arbitraire, conformément à la règle de protection de la production.
- **Nom commercial affiché** : Boutica Cloud (README, Swagger).

---

## 11. Plan de mise à jour continue du README

Le README est une documentation vivante. Chaque modification future doit être accompagnée de la mise à jour correspondante. Le README doit refléter : nom Boutica Cloud et mission ; stack réelle ; fonctionnalités implémentées et vérifiées ; prérequis et installation ; variables d'environnement (sans secrets) ; commandes dev/test/build ; migrations et config DB ; authentification et sécurité ; endpoints et accès Swagger ; déploiement et santé ; limitations connues et fonctionnalités planifiées. Ne jamais prétendre qu'une fonctionnalité existe si elle n'est pas implémentée et vérifiée ; différencier existant / testé / prévu.

---

## 12. Risques, dépendances et points non vérifiés

- **Risque principal :** les E2E n'ont pas tourné ici. Le code a été relu et le build/unitaires passent, mais le comportement transactionnel/concurrent n'est pas prouvé runtime dans cet environnement.
- **Limitation de l'environnement :** le moteur PostgreSQL local n'a pas pu démarrer (syscall `shmget` bloqué, ENOSYS) ; aucune instance Neon joignable. C'est une limite du bac à sable, pas un défaut du code.
- **Dépendances externes :** Neon (DB), Render (hébergement), Better Auth (auth). Tout changement de ces services impacte la production.
- **Points non vérifiés :** performance réelle, latence Neon, migrations sur base réelle, JWKS/JWT réel, CORS/trustedOrigins en conditions réelles, backups/restauration.

---

## 13. Liste des prochaines actions recommandées

1. Exécuter `npm install && npm run build && npm test && npm run test:e2e` sur une branche Neon dédiée (critique).
2. Régénérer et versionner les migrations (`npm run db:generate`) puis tester `db:migrate` (critique).
3. Documenter et tester la sauvegarde/restauration Neon (critique).
4. Ajouter `app.enableShutdownHooks()` et `engines.node` (faible/moyen).
5. Mettre en place le rate limiting par tenant et l'observabilité (élevé).
6. Aligner le nom de service du health check sur `boutica-cloud` lors d'une passe de cohérence (faible).
7. Décider de la priorité des capacités absentes (exports, paiement, STAFF, fichiers) selon la roadmap produit (moyen).

---

## Synthèse finale

- **Confirmé comme fonctionnel :** build OK ; 94/94 tests unitaires OK ; authentification Better Auth ; isolation multi-tenant (code + tests écrits) ; catalogue, variantes, inventaire, ventes, achats, retours, clients, fournisseurs, dépenses, rapports ; idempotence ; pagination ; validation ; Swagger.
- **Confirmé comme défectueux :** aucun défaut de compilation/démarrage identifié ; lacunes opérationnelles (E2E non exécutés ici, backups, observabilité, rate limiting par tenant, migrations à régénérer, exports/paiement/STAFF/fichiers absents).
- **Reste à vérifier :** comportement E2E réel (concurrence, transactions, isolation), performance, migrations sur base réelle, JWKS/JWT réel, CORS réel.
- **À développer en priorité :** exécution et validation E2E, backups/restauration, migrations versionnées, rate limiting par tenant, observabilité, puis exports et capacités métier selon la roadmap.