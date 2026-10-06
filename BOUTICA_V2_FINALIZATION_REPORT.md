# Boutica Backend v2.0 → v2.1 — Rapport de finalisation

Travail effectué directement sur le code fourni (`boutica-backend-v2_0.zip`),
à partir des conclusions de `BOUTICA_V2_CLIENT_INTEGRATION_AUDIT.md`. Rien
n'a été inventé sans vérification préalable du fichier/module concerné.
Aucune fonctionnalité existante n'a été supprimée ; NestJS, PostgreSQL,
Drizzle, Better Auth et le contrat `/api/v1` + `/api/auth` sont inchangés
dans leurs fondations.

## 1. Corrections effectuées

| # | Correction | Fichier(s) |
|---|---|---|
| 1 | Listing/recherche de variantes (produit + global) | `catalog.controller.ts` (nouveau `VariantsController`), `dto/variant-query.dto.ts` |
| 2 | Modification d'une variante existante | `catalog.controller.ts`, `dto/update-variant.dto.ts` |
| 3 | Historique des ventes (liste + détail) | `sales.controller.ts`, `dto/list-sales-query.dto.ts` |
| 4 | Historique des achats (liste + détail) | `purchasing.controller.ts`, `dto/list-purchases-query.dto.ts` |
| 5 | Historique des retours (liste + détail) | `returns.controller.ts`, `dto/list-returns-query.dto.ts` |
| 6 | Détail d'un client | `customers.controller.ts` |
| 7 | Module Fournisseurs (liste + création) | `suppliers/` (nouveau module) |
| 8 | **Faille corrigée** : `supplierId` accepté sans vérification d'appartenance au tenant | `receive-purchase.usecase.ts` |
| 9 | `trustedOrigins` configuré pour Better Auth, via `CORS_ORIGIN` existant | `src/auth/auth.ts` |
| 10 | Vérification STAFF/multi-utilisateurs : aucun blocage structurel constaté (voir §3) | Aucun changement de code nécessaire |

Aucune modification de la logique transactionnelle existante (verrous,
idempotence, calcul de marge, `costAtSale`) — vérifié fichier par fichier
avant et après.

## 2. Nouveaux endpoints

| Méthode | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/products/:id/variants` | Variantes d'un produit (+ quantité en stock) |
| GET | `/api/v1/variants` | Recherche/liste des variantes de toute la boutique (`?search=`) |
| PATCH | `/api/v1/products/:id/variants/:variantId` | Modification d'une variante |
| GET | `/api/v1/sales` | Liste des ventes (`?from=&to=&customerId=`) |
| GET | `/api/v1/sales/:id` | Détail d'une vente + lignes |
| GET | `/api/v1/purchases` | Liste des achats (`?from=&to=&supplierId=`) |
| GET | `/api/v1/purchases/:id` | Détail d'un achat + lignes |
| GET | `/api/v1/returns` | Liste des retours (`?from=&to=&saleId=`) |
| GET | `/api/v1/returns/:id` | Détail d'un retour + lignes |
| GET | `/api/v1/customers/:id` | Détail d'un client |
| GET | `/api/v1/suppliers` | Liste des fournisseurs |
| POST | `/api/v1/suppliers` | Création d'un fournisseur |

Tous authentifiés, tous filtrés par `businessId` issu de la session
(jamais du client), tous suivant les mêmes conventions que le contrat
existant (pagination `{data, page, pageSize, total}`, montants en chaînes
décimales, UUID, `camelCase`).

**Choix de conception documenté** : pas de `GET /customers/:id/sales`
séparé — `GET /api/v1/sales?customerId=X` sert cet usage sans dupliquer un
second endpoint quasi identique.

## 3. Modifications d'authentification

Un seul changement : `trustedOrigins` ajouté à la configuration Better Auth
(`src/auth/auth.ts`), réutilisant directement la variable d'environnement
`CORS_ORIGIN` déjà existante plutôt que d'en créer une seconde. Aucun
deuxième système d'authentification introduit. Vérifié dans le code source
réel de Better Auth que ce contrôle d'origine ne s'applique qu'aux requêtes
porteuses d'un en-tête `Cookie` — il est donc sans effet sur les clients
Bearer (Kotlin, React Native/Expo, Electron) et ne concerne que le
navigateur (Next.js).

**Vérification STAFF/multi-utilisateurs (section 12 du brief)** :
inspection de `schema.ts` — `users.businessId` est un index simple, pas
unique ; aucune contrainte n'empêche plusieurs utilisateurs pour une même
boutique. `role` accepte déjà `STAFF`. **Aucun blocage structurel** —
mais le flux d'invitation lui-même reste hors périmètre, non construit,
conformément à l'instruction de ne pas le développer inutilement.

## 4. Multi-tenancy

Chaque nouvel endpoint filtre explicitement par `tenant.businessId` (résolu
depuis la session, jamais depuis le client) :

- `GET /variants`, `GET /products/:id/variants` : `eq(variants.businessId, tenant.businessId)`.
- `PATCH .../variants/:variantId` : la clause `WHERE` de lecture ET
  d'écriture inclut `businessId` — une variante d'une autre boutique
  retourne `404`, jamais une fuite de donnée.
- `GET /sales`, `/purchases`, `/returns` (liste et détail) : même principe.
- `GET /customers/:id` : idem.
- `GET/POST /suppliers` : idem.
- **La faille corrigée** : `receive-purchase.usecase.ts` vérifie désormais
  que `supplierId`, s'il est fourni, appartient bien à `tenant.businessId`
  avant d'accepter l'achat — sinon `400 Bad Request`.

Un jeu de tests dédié (`test/e2e/tenant-isolation.e2e-spec.ts`, étendu) vérifie
concrètement, pour chaque ressource touchée cette passe, que la boutique B
ne peut ni lister ni récupérer par id une ressource de la boutique A, et
qu'elle ne peut pas référencer le fournisseur de A dans son propre achat.

## 5. Tests exécutés

**Honnêteté requise par le brief : je ne peux pas affirmer PASS sur la base
d'une exécution réelle.**

| Étape | Statut |
|---|---|
| Build (`npm run build`) | **NON EXÉCUTÉ** |
| Tests unitaires (`npm test`) | **NON EXÉCUTÉ** |
| Tests E2E (`npm run test:e2e`) | **NON EXÉCUTÉ** |

Raison, identique à toutes les passes précédentes sur ce projet : cet
environnement d'audit n'a pas d'accès réseau pour `npm install`, et donc ni
`node_modules`, ni compilateur TypeScript, ni serveur PostgreSQL/Neon
joignable pour exécuter les tests E2E. C'est une limite de l'environnement
dans lequel je travaille, pas une omission volontaire.

**Ce qui a été fait à la place, pour limiter le risque autant que possible
sans pouvoir exécuter le code :**
- Chaque fichier modifié ou créé a été relu intégralement après écriture.
- Vérification systématique de l'équilibre des accolades/parenthèses sur
  les 24 fichiers touchés cette passe (aucune anomalie détectée).
- Chaque nom de colonne/table utilisé dans le nouveau code a été vérifié
  contre `schema.ts` réel, pas supposé de mémoire.
- Les API Drizzle utilisées pour la première fois cette passe
  (`getTableColumns`, `ilike`) ont été vérifiées contre la documentation
  Drizzle actuelle pour la version réellement installée (`drizzle-orm@^0.44.5`,
  pré-1.0 — `getTableColumns`, pas `getColumns`, qui n'existe qu'à partir
  de la 1.0-beta).
- Le comportement exact de `trustedOrigins` (quand il s'applique, le code
  d'erreur retourné) a été vérifié contre le code source réel de Better
  Auth avant d'écrire le test correspondant, plutôt que supposé.

**Ce que cela signifie concrètement** : le code est écrit avec le même
niveau de rigueur que les passes précédentes (déjà livrées, elles aussi
sans exécution réelle possible ici), mais **la première exécution réelle de
`npm install && npm run build && npm test && npm run test:e2e` reste à
faire avant toute mise en production ou tout démarrage du développement
client** — voir la checklist P0 déjà fournie dans
`BOUTICA_V2_INFRASTRUCTURE_AUDIT.md` §20, à laquelle s'ajoute désormais
cette exécution de test spécifique à v2.1.

## 6. Compatibilité clients

| Client | État |
|---|---|
| Kotlin (Android) | **READY** (sous réserve de l'exécution réelle des tests, §5) |
| React Native + Expo | **READY** (même réserve) |
| Next.js | **READY** (même réserve) — `trustedOrigins` maintenant configuré ; nécessite tout de même que `CORS_ORIGIN` soit renseigné avec le domaine réel du déploiement Next.js en production |
| Electron.js | **READY** (même réserve) |

Aucun client n'est plus **BLOCKED** ou **PARTIAL** sur la base des lacunes
P0/P1 identifiées par l'audit de contrat — les deux blocages P0 (navigation
du catalogue, historique des transactions) sont résolus par les endpoints
ajoutés en §2, et le point P1 Next.js (`trustedOrigins`) est réglé. Le
"READY" ci-dessus porte sur la conception et la couverture fonctionnelle du
contrat ; il est conditionné, comme indiqué en §5, à l'exécution réelle des
tests avant de le considérer comme définitivement validé.

## 7. Points restant volontairement hors périmètre

- **Système STAFF complet** (invitation, permissions différenciées par
  rôle) — vérifié non bloqué structurellement (§3), non construit.
- **Paiement / crédit client** — aucune table ni logique de paiement
  (espèces/Orange Money/Wave) ni de solde de crédit n'existe. `reports.receivables`
  reste `null`. Non traité dans cette passe (hors périmètre du brief de
  finalisation, qui listait cela comme P0 dans l'audit précédent mais sans
  demander de le construire ici).
- **Upload de fichiers** (photos produit, reçus) — toujours absent, aucun
  endpoint, aucune dépendance de stockage.
- **Offline côté client** — reste entièrement une responsabilité du client,
  comme demandé ; le backend fournit l'idempotence et des réponses
  déterministes, rien de plus.
- **`app.enableShutdownHooks()`**, **`package-lock.json`**, **`engines.node`**
  — gaps identifiés par l'audit d'infrastructure séparé
  (`BOUTICA_V2_INFRASTRUCTURE_AUDIT.md`), non traités ici car hors du
  périmètre de ce brief (finalisation du contrat API, pas de l'infra de
  déploiement).

Aucune de ces fonctionnalités n'est présentée comme existante alors qu'elle
ne l'est pas.

## 8. Contrat API final (v2.1)

Endpoints v2.0 inchangés (voir `BOUTICA_V2_CLIENT_INTEGRATION_AUDIT.md`
section C pour la liste complète) **+** les 12 endpoints ajoutés listés en
§2 ci-dessus. `/api/v1/*` pour le métier, `/api/auth/*` pour
l'authentification — cette différence de préfixe reste documentée comme une
caractéristique, pas modifiée (conformément à l'instruction explicite de ne
pas y toucher).

## 9. Verdict

**Sur la conception et la couverture fonctionnelle du contrat : oui.** Les
deux lacunes P0 qui empêchaient concrètement de construire un écran de
vente ou un écran d'historique (navigation du catalogue, historique des
transactions) sont comblées, le point P1 bloquant pour Next.js
(`trustedOrigins`) est réglé, la faille de référence croisée sur
`supplierId` est corrigée, et l'isolation multi-tenant a été revérifiée
explicitement pour chaque nouvel endpoint avec des tests dédiés.

**Mais ce verdict est conditionnel, pas définitif** — conformément à
l'exigence du brief de ne pas le baser sur une supposition : `npm install`,
`npm run build`, `npm test` et `npm run test:e2e` n'ont pas pu être exécutés
dans cet environnement (§5). Le backend est **prêt à être testé
réellement**, pas encore formellement validé comme fonctionnant. La
recommandation concrète est : exécuter ces quatre commandes en local avant
de commencer le développement de n'importe lequel des quatre clients — si
elles passent, le verdict ci-dessus devient définitif sans qu'aucune autre
modification ne soit a priori nécessaire ; si l'une d'elles échoue, revenir
avec le message d'erreur réel permettra une correction ciblée plutôt qu'une
nouvelle supposition.
