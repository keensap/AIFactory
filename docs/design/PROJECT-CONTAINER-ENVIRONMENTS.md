# Future Requirements: Local Project Container Environments

**Status:** proposed; not implemented  
**Version:** 0.1  
**Scope:** local-machine project workspaces, project-specific container environments, and automated Git delivery  
**Out of scope:** shared-server and Kubernetes execution; this proposal targets a user's own machine first.

---

## 1. Purpose

Allow a user to work with AI Factory in either of two modes:

1. **Host workspace:** AI Factory uses a project directory already present on the user's machine. This preserves the current workflow.
2. **Container workspace:** AI Factory creates and runs a project-specific environment in a local container. The user's project files live in a persistent host directory mounted into the container.

Container mode should let projects use different languages, toolchains, and system packages without installing every project's stack directly on the host. The Factory proposes and maintains the container environment from the project's approved technical decisions. Agents can commit and push completed task changes so routine Git operations do not require manual intervention.

The project workspace—not the container's writable layer—is the durable location for project files. The container and image can be recreated without losing files in the mounted workspace.

## 2. Goals and principles

- Preserve the existing host-path workflow.
- Make a local, per-project container an alternative execution environment.
- Keep source, documents, configuration, and generated project files in a user-selected persistent host directory.
- Derive environment proposals from approved project decisions, not speculative early-stage choices.
- Require the user's approval before adopting a material environment change.
- Version the environment definition and project work in the configured Git remote(s).
- Support both a monorepo and multiple repositories within one logical project.
- Keep credentials out of images, source files, logs, and agent prompts.
- Make container recreation and recovery understandable to the user.

## 3. Terminology

| Term | Meaning |
|---|---|
| **Project workspace** | Host directory holding the project's checked-out repositories, documents, and working files. In container mode it is mounted into the project container. |
| **Environment definition** | Versioned files describing how to build and run the project environment, such as a generated `Dockerfile`, Compose/configuration file, and environment manifest. |
| **Environment image** | Built container image containing the project's approved operating-system packages, language runtimes, and development tools. It does not contain the sole copy of project work. |
| **Project container** | Local container created from an approved environment image and connected to the persistent workspace. |
| **Repository mapping** | A Git remote and its relative checkout directory within the project workspace. |
| **Environment proposal** | A reviewable set of proposed environment-definition changes, with rationale and impact, awaiting user approval. |

## 4. Project setup and workspace modes

### PE-ENV-001 — Select a workspace mode

During project setup, the user MUST be able to choose either host workspace mode or container workspace mode. Existing host workspace behavior MUST remain available and MUST NOT require Docker.

### PE-ENV-002 — Configure a container workspace

For container mode, the user MUST be able to configure:

- a project/container display name (the Factory may derive a safe unique container name);
- an absolute host path for the persistent project workspace;
- one or more Git repository remotes, each with a relative checkout directory;
- the project's initial environment source, such as a Factory-recommended base image or a user-provided base image;
- applicable local resource and network policies exposed by the Factory.

The Factory MUST validate the workspace path and repository mappings before creating or modifying files. It MUST prevent a repository checkout from escaping the configured workspace.

### PE-ENV-003 — Configure one or more repositories

Container mode MUST require at least one Git remote before project work begins. The user MAY configure multiple remotes for separate components (for example, backend, frontend, documentation, or serverless functions) or one remote for a monorepo.

Each remote MUST map to a stable, explicit relative directory. Duplicate or overlapping checkout paths MUST be rejected unless a supported Git-submodule or worktree arrangement explicitly permits them. Each repository's branch and push policy MUST be visible to the user.

### PE-ENV-004 — Persist workspace files on the host

The project workspace MUST be mounted from a user-selected host directory or equivalent durable local volume. Documents and source files created by the Factory or agents MUST be written into that persistent workspace, not solely into the container's writable layer.

Stopping, deleting, or recreating a project container MUST NOT delete the workspace. The UI/API MUST clearly distinguish actions that affect a container/image from actions that delete project data. Workspace deletion MUST require an explicit user action and confirmation.

## 5. Environment proposal and lifecycle

### PE-ENV-005 — Start with a minimal environment

Before the project's technology stack is approved, the Factory MUST use or recommend a minimal Linux-based environment suitable for producing and editing planning, requirements, and design documents. It MUST NOT install or assume an unapproved application stack merely because a draft mentions one.

### PE-ENV-006 — Recommend and generate environment definitions

When project design establishes an application technology stack, the Factory MUST be able to:

- recommend a suitable base image and required development tools;
- generate or update environment-definition files, such as a `Dockerfile` and supporting configuration;
- explain each material addition, removal, and version change;
- identify the project decision or approved design document supporting the proposal;
- show a human-reviewable diff before the proposal is applied.

Generated files MUST be ordinary, inspectable project files. The image itself SHOULD be buildable from those versioned files rather than treated as the only record of the environment.

### PE-ENV-007 — Require approval for environment changes

A material change to the base image, operating-system packages, language runtimes, toolchains, or environment configuration MUST be presented as an environment proposal and MUST NOT become the active project environment until an authorized user approves it.

Approval MUST identify the proposal version or diff being accepted. If the proposal changes after approval, the changed version MUST require approval again. The Factory MUST record who approved the proposal and when.

### PE-ENV-008 — Build, verify, record, and activate

After approval, the Factory MUST build a candidate image and report build/verification results. On success, it MUST commit and push the approved environment-definition files under the configured Git policy, record the resulting commit and image identity (including an image digest when available), and activate that candidate for subsequent tasks.

The Factory MUST NOT remove the previously active image/container or alter the persistent workspace merely because a candidate build fails. A failed candidate MUST leave the previous approved environment available for recovery. The user MUST be told whether a failed build produced any workspace changes.

Environment files MUST NOT contain credentials. Built images SHOULD use pinned base-image references and the project's dependency lockfiles where available. The Factory MUST explain any dependencies that remain unpinned or otherwise limit reproducibility.

### PE-ENV-009 — Keep environment history inspectable

The project MUST retain a history of environment proposals, approvals, build outcomes, active image identity, and related Git commits. A user MUST be able to determine which approved environment was active for a given task/run.

The Factory MUST NOT commit a built image binary to a project Git repository by default. It SHOULD retain or rebuild the image locally using the versioned definition and recorded identity.

## 6. Automated Git delivery

### PE-ENV-010 — Commit and push completed tasks

For container-mode projects, agents MUST be able to commit and push completed task changes to the configured remote repository or repositories so the user does not need to perform routine commits and pushes manually.

A task is eligible for automatic delivery only after its configured completion checks pass. The task record MUST include the repository, branch, commit identifier, push result, and any failure reason. Only repositories changed by the task SHOULD receive commits.

### PE-ENV-011 — Respect branch and review policy

Automatic delivery MUST follow a per-project Git policy. The default SHOULD push task work to a task/run branch and MUST NOT bypass protected-branch rules or force-push. Direct pushes to a shared branch MAY be allowed only when explicitly configured by the project owner and supported by the remote.

Automatic push does not imply automatic merge. Existing review, approval, and merge rules remain in force. The Factory MUST report whether work was pushed, rejected, or left local for user action.

### PE-ENV-012 — Preserve user work and prevent unsafe commits

Before changing a repository, the Factory MUST detect unrelated, uncommitted user changes and MUST NOT silently overwrite, discard, or include them in an agent commit. If safe task-level isolation is unavailable, the Factory MUST pause and ask for user direction.

The Factory MUST scan proposed commits for credentials and configured excluded paths. It MUST NOT commit secrets, local credential files, container caches, or generated artifacts excluded by project policy. Large or binary artifacts SHOULD be stored through a suitable artifact mechanism rather than pushed to Git by default.

### PE-ENV-013 — Handle Git credentials safely

Git authentication MUST use credentials made available through an approved host-side mechanism (for example, a credential helper or SSH-agent forwarding). Credentials MUST NOT be copied into the generated Dockerfile, image layers, repository contents, environment proposal, or ordinary logs.

The Factory MUST explain and test the authentication method before the first push. A failed authentication MUST leave local changes intact and provide a clear recovery action.

## 7. Local execution and security

### PE-ENV-014 — Use a local container runtime

Container mode MUST detect a supported local container engine and report actionable setup guidance if none is available. The first implementation SHOULD target Docker-compatible local execution; support for other engines may be added without changing the project/workspace model.

The Factory MUST make clear that the user is responsible for installing and operating the local container engine. The Factory itself MUST NOT require every project's language runtime or development toolchain to be installed on the host.

### PE-ENV-015 — Restrict project container privileges

Project containers MUST run without privileged mode by default, MUST use a non-root user where feasible, and MUST NOT receive unrestricted host filesystem access. Only the workspace and explicitly approved paths may be mounted.

The design MUST avoid exposing the Docker socket or equivalent host-control interface directly to model-driven project processes. Any host-side runner that needs container-engine access MUST be a narrowly scoped, explicitly authorized component. Resource limits and network access controls SHOULD be configurable per project.

## 8. Recovery and user visibility

### PE-ENV-016 — Recover after container failure

If a project container exits unexpectedly, the Factory MUST report the failure, preserve the mounted workspace, and allow the user to inspect logs and restart or recreate the container from the last approved image. Recreating the container MUST not silently reset repository branches or discard working-tree changes.

The Factory MUST distinguish at least:

- container failure;
- image build failure;
- workspace mount or permission failure;
- Git fetch/commit/push failure;
- project task failure.

### PE-ENV-017 — Make durable and ephemeral data explicit

The Factory MUST tell the user which data is stored in the host workspace, which state belongs only to the container, and which data is stored remotely in Git. The Factory SHOULD provide a status view showing workspace path, container state, active image, repository remotes/branches, uncommitted changes, and last successful push.

The Factory MUST warn that a host-mounted directory protects files against container removal or crash, but not against loss of the host machine or its storage. Git push and any configured backup are the recovery mechanisms for those failures.

## 9. Acceptance scenarios

1. **Host workflow remains available:** a user creates or opens a project at a physical path and runs the current host-based workflow without installing or starting Docker.
2. **Container project bootstrap:** a user supplies a workspace path and one remote; the Factory creates the checkout under the workspace, starts a minimal environment, and creates all project documents in the mounted directory.
3. **Multiple repositories:** a user configures backend, frontend, and documentation remotes; the Factory checks each out into its configured directory and reports repository-specific status.
4. **Monorepo:** a user supplies one remote; the Factory operates within the single checkout without requiring artificial component repositories.
5. **Stack becomes known:** planning and requirements use the minimal environment; after the design's stack is approved, the Factory presents a Dockerfile/configuration proposal and rationale without applying it automatically.
6. **Environment approval and activation:** after approval, the candidate image builds and verifies, the definition is committed and pushed, and subsequent tasks use the candidate. If build fails, the prior environment and workspace remain intact.
7. **Container crash:** a container is stopped or removed unexpectedly; project documents and source remain in the host workspace and the Factory can recreate the container without deleting them.
8. **Automated task delivery:** after successful checks, an agent commits and pushes changed files to the configured task branch; the user can see the commit and push result and still reviews/merges under the project's policy.
9. **Unsafe working tree:** unrelated user edits exist; the Factory does not include or overwrite them silently and asks the user how to proceed.
10. **Credential safety:** a remote requires authentication; the Factory pushes using the approved host credential mechanism and no credential appears in the image, repository, generated files, or ordinary logs.

## 10. Non-goals for the initial implementation

- Running project containers on a shared AI Factory server or cloud cluster.
- Kubernetes orchestration or multi-host scheduling.
- Treating a container's writable layer as durable project storage.
- Automatically merging agent commits into protected branches.
- Committing container images or credentials to Git.
- Guaranteeing bit-for-bit reproducible builds where upstream images or dependencies are not pinned.
- Requiring users to adopt container mode for existing host-workspace projects.

## 11. Open design decisions

These decisions should be resolved before implementation planning:

1. Which container engine(s) are supported in the first release, and how will engine access be isolated from model-driven processes?
2. Is a host bind mount mandatory initially, or may users choose a Docker-managed named volume with a documented file access/export workflow?
3. What exact project files represent the generated environment: Dockerfile only, Compose/Dev Container files, or a Factory manifest plus generated files?
4. How should stack decisions map to a curated, maintainable set of image recommendations, and how can the user override them?
5. What is the default automatic-push branch strategy, and how should branch protection and pull-request creation be handled across Git providers?
6. How should multi-repository tasks coordinate commits and partial push failures when one repository succeeds and another fails?
7. What artifact types should remain outside Git, and what local retention or backup policy should be offered?
8. Which resource and network restrictions are practical for local containers across supported operating systems?

---

*This is a proposed future capability and does not describe current AI Factory behavior. The present implementation continues to use configured project paths and does not yet create or manage project containers or automatically push agent commits.*
