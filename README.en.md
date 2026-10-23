<p align="center">
  <img src="assets/readme/beeftv-wordmark.svg" width="640" alt="BeefTV — High-performance, lightweight, AI-native video workspace">
</p>

<p align="center"><strong>High-performance · Lightweight · AI Native</strong></p>

<p align="center">
  An AI-native workspace for video creation.<br>
  Connect ideas, models, and media on one freeform canvas.
</p>

<p align="center">
  Create with BeefTV Agent, extend your methods with Skills, and reuse your process with Workflows.<br>
  From storyboards and media to finished videos, keep your work editable and ready to build on.
</p>

<p align="center">
  <a href="https://github.com/glanderness/BeefTV/stargazers"><img src="https://img.shields.io/github/stars/glanderness/BeefTV?style=flat-square&amp;logo=github&amp;label=Stars&amp;labelColor=303030&amp;color=E86C36" alt="BeefTV GitHub stars"></a>
  <a href="https://github.com/glanderness/BeefTV/releases/latest"><img src="https://img.shields.io/github/v/release/glanderness/BeefTV?style=flat-square&amp;label=Release&amp;labelColor=303030&amp;color=525252" alt="Latest BeefTV release"></a>
  <a href="QUICKSTART.md#下载与首次打开"><img src="https://img.shields.io/badge/Desktop-macOS%20%7C%20Windows-525252?style=flat-square&amp;labelColor=303030" alt="Desktop support for macOS and Windows"></a>
  <a href="QUICKSTART.md"><img src="https://img.shields.io/badge/Workspace-Local--first-525252?style=flat-square&amp;labelColor=303030" alt="Local-first workspace"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Source%20Available-525252?style=flat-square&amp;labelColor=303030" alt="Source-available license; see LICENSE for terms"></a>
</p>

<p align="center">
  <a href="https://beeftv.app/"><img src="assets/readme/button-website.svg" width="180" alt="Visit the BeefTV website"></a>
  <a href="https://github.com/glanderness/BeefTV/releases/latest"><img src="assets/readme/button-download.svg" width="175" alt="Download BeefTV desktop app"></a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="#product-demo">Product demo</a> ·
  <a href="#beeftv-agent">Agent</a> ·
  <a href="#skills">Skills</a> ·
  <a href="#workflows">Workflows</a> ·
  <a href="docs/content/docs/overview/features.mdx">Feature list</a> ·
  <a href="QUICKSTART.md">Get started</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

## Product demo

https://github.com/user-attachments/assets/94fe6a39-6933-44b3-a9a9-dbc28b2d284c

[Download the demo](assets/readme/beeftv-demo.mp4) · An early canvas interface demo. For 2.0 features, see the sections below and the [release notes](https://github.com/glanderness/BeefTV/releases/latest).

[See the 2.0.1 hands-on examples](docs/content/docs/overview/examples.mdx) (Chinese): an editable storyboard, three text skills, and a workflow reused with two inputs.

## BeefTV Agent

**Turn creative intent into an editable deliverable.**

Describe your goal. The creative assistant prepares storyboards, organizes references, and proposes a generation plan. After you confirm the plan, it can continue generating media, checking results, editing, and exporting a finished video with an editable project.

- **Create in context:** Work with the media and creative context on your canvas.
- **Review, then proceed:** Check the plan before production and follow task progress.
- **Keep control:** Review results and continue refining the media and edit.

![BeefTV Agent delivers the confirmed coffee storyboard as two editable text nodes](assets/readme/beeftv-2.0.1-agent-delivery.webp)

**Hands-on example: an 8-second coffee storyboard.** Describe someone receiving coffee at night and looking up at dawn → confirm the two-shot plan → let the Agent write duration, visuals, and sound into two editable text nodes. This example delivers a text storyboard; no finished video was generated. [See the request and deliverable](docs/content/docs/overview/examples.mdx#agent从创意到两个可编辑分镜) (Chinese).

Generation requires configured model providers. Audiovisual checks also require a supported multimodal model. Review subtitles, visuals, and local text layout yourself.

[Explore the creative assistant](docs/content/docs/overview/features.mdx#beeftv-agent创作助手)

## Skills

**Keep your creative methods ready to use.**

Give the creative assistant methods, steps, and requirements for specific tasks. Browse the skill marketplace, review requirements and files, then install a specific version.

![BeefTV 2.0.1 skill marketplace: browse skills, purposes, and fixed versions](assets/readme/beeftv-2.0.1-skills.webp)

| Official skill | Actual deliverable in this session |
| --- | --- |
| Two-shot text storyboard | Coffee short: two 4-second shots, with visuals, sound, and items to confirm. |
| Interview outline | Community bookstore: three open questions, follow-ups, supporting footage, and permissions. |
| Media inventory | Coffee video + dawn photo: purposes, stated permissions, and duration and sound gaps. |

Captured from the installed 2.0.1 app. These runs used private local copies of the official 1.0.0 skill files. The marketplace still labels their results as unverified. [See all three inputs and results](docs/content/docs/overview/examples.mdx#skills三个文字任务) (Chinese).

- **Use what you need:** Enable or disable installed skills in your library.
- **Manage versions:** Check for updates or return to a previously installed version.
- **Make it yours:** Create a private adaptation. Authors can prepare submissions, with separate confirmations for upload and public review.

Text-only skills do not require a multimodal model. Skills involving images, video, or audio require the capabilities listed in their requirements.

[Explore skill use and management](docs/content/docs/overview/features.mdx#skills创作技能)

## Workflows

**Save the steps that work for your next creation.**

Save canvas nodes as a reusable workflow with replaceable inputs, fixed content, and outputs. Swap in new media and run it again with your existing configuration.

| First run: racing video | Second run: neon street video |
| --- | --- |
| ![The keyframe workflow completes with a racing video and outputs a driver frame](assets/readme/beeftv-2.0.1-workflow-first.webp) | ![The same workflow completes with a neon street video and outputs a street frame](assets/readme/beeftv-2.0.1-workflow-second.webp) |

**Hands-on example: one template, two inputs.** Save a local keyframe extraction workflow, run the racing video, then replace it with the neon street video. Both runs keep template version 1 and the same extraction settings, show “Completed 1 / 1,” and output their respective first frames. Processing runs locally without model calls. [See the reuse steps](docs/content/docs/overview/examples.mdx#workflows同一模板两组素材) (Chinese).

- **Capture from the canvas:** Select nodes and choose “Save as workflow.”
- **Edit the template:** Adjust nodes, connections, models, and processing parameters.
- **Run with new inputs:** Add it to the canvas, bind new media, and follow progress and results.

Workflows support generation and media processing steps; the editor indicates which operations are supported. Model generation is billed by your chosen provider.

[Explore workflow creation and reuse](docs/content/docs/overview/features.mdx#将画布节点保存为可复用工作流)

## One canvas, a complete creative workflow

- **Generate:** Create text, images, video, and audio from prompts or reference media.
- **Organize:** Connect nodes to build relationships between assets, creative context, and generation steps.
- **Refine:** Crop, annotate, inpaint, split, reference, and combine results.
- **Iterate:** Keep your process and reuse assets, turning a single generation into an evolving workflow.

BeefTV also includes project and personal asset libraries, asynchronous tasks, model providers, and creative tools. See the full [feature list](docs/content/docs/overview/features.mdx).

## Why BeefTV

| High Performance | Lightweight | AI Native |
| --- | --- | --- |
| Rendering, media previews, and task handling optimized for complex canvases. | Local-first, with one desktop workspace to get started and capabilities loaded as needed. | An Agent to advance your work, Skills to guide it, and Workflows to reuse the steps. |

## Open by design

- Configure text, image, video, and audio model providers freely, without being tied to a single provider.
- Manage projects, canvases, assets, and tasks in one workspace, with data that can be saved and migrated locally.
- Built for desktop with React, Go, and Wails, with extensible model protocols and workspace capabilities.

## Get started

1. [Download the desktop app](https://github.com/glanderness/BeefTV/releases/latest) and follow the [first-launch instructions](QUICKSTART.md#下载与首次打开). Enter your local workspace without signing up.
2. In model settings, connect BeefAPI or add your own model provider.
3. Create a canvas, add reference media, and describe your goal to the creative assistant. You can also start creating directly with nodes.

See [Quick Start](QUICKSTART.md) for model setup and building from source, and the [desktop release guide](docs/desktop-release.md) for packaging requirements.

## Community

Discuss creative methods, share skills and workflows, or report issues.

<p>
  <a href="https://beeftv.app/assets/beeftv-wecom-qr.png"><img src="assets/readme/button-community.svg" width="185" alt="Scan to join the BeefTV community"></a>
  <a href="https://x.com/beefnoode"><img src="assets/readme/button-x.svg" width="180" alt="Follow @beefnoode on X"></a>
</p>

## Contributing and license

Issues and pull requests are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow and testing requirements.

The repository uses licenses with different scopes. Original content added under the new license, starting with the commit that first introduced it and subject to its terms, is covered by the [`BeefTV Source Available License 1.0`](LICENSE). Historical content released under MIT remains under the MIT terms retained in the same file. Upstream and third-party materials keep their respective licenses.

The new license permits self-hosting, internal customization, and creating and selling works with BeefTV. Written authorization is required for commercial resale, rebranding and resale, paid deployment or custom delivery of covered software, and providing hosted features to third parties, whether free or paid. Independent tutorials, training, and general technical consulting may be paid services, but must not be used to deliver the software system indirectly. Contact us about authorization at [lucas@bf-labs.cn](mailto:lucas@bf-labs.cn).

The new restrictions do not apply retroactively to historical MIT content or override independently licensed third-party materials. This is a source-available license; the entire repository should not be treated as standard MIT or as an open source project under the OSI definition. See the [license guide](docs/content/docs/overview/licensing.mdx) for covered scenarios and boundaries, and [`NOTICE`](NOTICE) for upstream sources and third-party attributions.

## ⭐ Star History

<a href="https://www.star-history.com/?repos=glanderness%2FBeefTV&amp;type=date&amp;legend=bottom-right">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=glanderness/BeefTV&amp;type=date&amp;theme=dark&amp;legend=bottom-right" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=glanderness/BeefTV&amp;type=date&amp;legend=bottom-right" />
    <img alt="BeefTV GitHub star history" src="https://api.star-history.com/chart?repos=glanderness/BeefTV&amp;type=date&amp;legend=bottom-right" />
  </picture>
</a>
