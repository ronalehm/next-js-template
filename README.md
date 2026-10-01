# next-js-template

Plantilla base para los proyectos de Ronald: Next.js 16 con una estructura modular por dominio y un flujo de desarrollo con agentes de Claude Code basado en **SDD (Spec Driven Development)**, con aprobación humana obligatoria.

## Stack

| Área | Tecnología |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack), React 19, TypeScript strict |
| Estilos | Tailwind CSS v4 (tema en `app/globals.css`, sin `tailwind.config`) |
| UI | shadcn/ui (estilo `base-nova`, sobre Base UI) + `lucide-react` |
| Datos | axios, TanStack Query, TanStack Table |
| Validación y estado | zod, zustand |
| Tests | Vitest + Testing Library (jsdom) |

Requisitos: Node 22 o superior y npm.

## Inicio rápido

```sh
git clone https://github.com/ronalehm/next-js-template.git mi-proyecto
cd mi-proyecto
npm install
npm run dev        # http://localhost:3000
```

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Build de producción (también hace la comprobación de tipos completa) |
| `npm run start` | Sirve el build de producción |
| `npm run lint` | ESLint |
| `npm test` | Vitest en modo watch |
| `npx vitest run [ruta]` | Ejecuta los tests una vez (todo, un módulo o un archivo) |
| `npx shadcn@latest add <componente>` | Añade un componente de shadcn/ui a `components/ui/` |

## Estructura

```
app/              # solo rutas (App Router)
components/
  ui/             # componentes de shadcn/ui
  shared/         # componentes reutilizables entre dominios
hooks/            # hooks reutilizables entre dominios
lib/              # utilidades globales (cliente axios, utils)
modules/<dominio>/  # código de negocio: components, hooks, services, schemas, stores, types
docs/
  SETUP.md        # reglas del proyecto
  specs/          # especificaciones SDD
.claude/
  agents/         # agentes orchestrator, spec, developer, reviewer
  hooks/          # hooks de aprobación de specs
```

Las reglas completas (estructura, nombres, SOLID/DRY/KISS/YAGNI, qué lleva tests) están en [`docs/SETUP.md`](docs/SETUP.md). Léelo antes de escribir código.

## Flujo de trabajo con Claude Code

El proyecto incluye 4 agentes en `.claude/agents/`:

| Agente | Rol |
|---|---|
| `orchestrator` | Decide si el pedido es **build** (cambio pequeño y claro) o **SDD**, planifica y coordina a los demás, en paralelo cuando las tareas no comparten archivos |
| `spec` | Escribe la spec en `docs/specs/<module>-<feature>.md`, con un plan de tareas que cabe en una sesión |
| `developer` | Implementa una spec aprobada o un cambio en modo build, con sus tests |
| `reviewer` | Revisa contra la spec y `docs/SETUP.md`; devuelve observaciones hasta aprobar |

Para usarlo:

```sh
claude --agent orchestrator
```

y describe la funcionalidad que quieres.

### Aprobación de specs

Ninguna spec se implementa sin tu aprobación. Cuando el orquestador te muestre la spec, apruébala escribiendo en el chat:

```
apruebo docs/specs/<slug>.md
```

Un hook cambia la spec de `Estado: borrador` a `Estado: aprobado`, registra quién aprobó en `docs/specs/approvals.jsonl` (con una firma cuya clave se guarda en `~/.claude/spec-approval.key`) y Claude continúa con la implementación.

Bloqueos técnicos (`.claude/settings.json` y `.claude/hooks/spec-approval.mjs`):

- Solo tu mensaje en el chat puede aprobar una spec; Claude solo puede escribirlas con `Estado: borrador`.
- El agente `developer` no se lanza si la spec no está aprobada o cambió después de aprobarse.
- El `developer` no puede modificar nada en `docs/specs/`.
- Las aprobaciones son por equipo: una spec aprobada en otra máquina hay que aprobarla de nuevo en la tuya.

Tests de los hooks: `npx vitest run .claude/hooks`.

## Skills recomendadas

Plugins y skills de Claude Code que complementan esta plantilla. Los comandos con `/plugin` se escriben dentro de Claude Code; reinicia la sesión después de instalar.

| Skill | Para qué | Instalación |
|---|---|---|
| [**frontend-design**](https://github.com/anthropics/claude-plugins-official) (Anthropic) | Interfaces con diseño cuidado en vez del aspecto genérico de IA. Se activa sola al pedir pantallas o componentes. | `/plugin install frontend-design@claude-plugins-official` |
| [**ui-ux-pro-max**](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | Base de datos de estilos, paletas, tipografías y guías de UX para elegir el diseño de un producto. | `/plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill`<br>`/plugin install ui-ux-pro-max@ui-ux-pro-max-skill` |
| [**vercel-labs/agent-skills**](https://github.com/vercel-labs/agent-skills) | Buenas prácticas de React y Next.js de Vercel (rendimiento, waterfalls, bundle, re-renders). Encaja con el stack de la plantilla. | `npx skills add vercel-labs/agent-skills` |
| [**ponytail**](https://github.com/dietrichgebert/ponytail) | Fuerza la solución más simple que funcione: YAGNI, librería estándar antes que dependencias, menos código. Refuerza KISS/YAGNI de `SETUP.md`. | `/plugin marketplace add dietrichgebert/ponytail`<br>`/plugin install ponytail@ponytail` |
| [**caveman**](https://github.com/JuliusBrussee/caveman) | Respuestas ultracompactas de Claude: menos tokens de salida sin perder precisión técnica. | `/plugin marketplace add JuliusBrussee/caveman`<br>`/plugin install caveman@caveman` |
| [**superpowers**](https://github.com/obra/superpowers) | Biblioteca de skills de ingeniería: brainstorming, planificación, TDD, depuración sistemática y revisión de código. | `/plugin marketplace add obra/superpowers-marketplace`<br>`/plugin install superpowers@superpowers-marketplace` |

Cómo combinarlas:

- **Diseño:** `ui-ux-pro-max` para decidir el estilo y `frontend-design` para construir la interfaz, siempre usando los componentes de shadcn/ui y los tokens del tema de `app/globals.css`.
- **Código:** `vercel-labs/agent-skills` para el rendimiento de React/Next y `ponytail` para no sobrediseñar.
- **superpowers** trae su propio flujo de planificación y ejecución. En este proyecto manda el flujo SDD (spec aprobada → developer → reviewer); usa sus skills de TDD y depuración dentro de ese flujo, no como sustituto.
- **caveman** es opcional: reduce el coste, pero las respuestas son muy telegráficas. Desactívalo cuando necesites explicaciones detalladas.
