<script lang="ts">
  import brandMark from "@shared-frontend/assets/modbus-lab-client.svg";

  const sampleBlocks = [
    { label: "Identity", value: "ModbusLab Server" },
    { label: "Mode", value: "TCP slave simulator" },
    { label: "Shared theme", value: "Loaded from shared package" },
  ];

  const sampleRegisters = [
    { address: 0, name: "Pump Demand", value: "0x0012" },
    { address: 1, name: "Line Speed", value: "0x0084" },
    { address: 2, name: "Tank Level", value: "0x0049" },
  ];
</script>

<svelte:head>
  <title>ModbusLab Server</title>
</svelte:head>

<div class="server-page">
  <section class="hero panel-frame">
    <div class="hero-copy">
      <p class="eyebrow">Shared assets and styles check</p>
      <h1>ModbusLab Server sample</h1>
      <p class="lede">
        This placeholder app lives in its own workspace package, imports the shared frontend stylesheet,
        and renders a shared brand asset.
      </p>
      <div class="meta-grid">
        {#each sampleBlocks as block}
          <article class="meta-card">
            <span>{block.label}</span>
            <strong>{block.value}</strong>
          </article>
        {/each}
      </div>
    </div>

    <div class="hero-brand">
      <div class="logo-wrap">
        <img src={brandMark} alt="ModbusLab shared brand mark" />
      </div>
      <div class="signal-chip">Shared asset imported from packages/shared-frontend</div>
    </div>
  </section>

  <section class="content-grid">
    <article class="panel-frame register-panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Sample state</p>
          <h2>Holding register image</h2>
        </div>
        <span class="status-pill">Online</span>
      </div>

      <div class="register-table">
        {#each sampleRegisters as register}
          <div class="register-row">
            <span class="address">{register.address}</span>
            <span class="name">{register.name}</span>
            <strong>{register.value}</strong>
          </div>
        {/each}
      </div>
    </article>

    <article class="panel-frame notes-panel">
      <p class="eyebrow">Why this exists</p>
      <h2>First server scaffold</h2>
      <ul>
        <li>Separate app entrypoint under apps/server</li>
        <li>Shared CSS variables and base styling loaded from one place</li>
        <li>Shared SVG asset resolved through the workspace alias</li>
      </ul>
    </article>
  </section>
</div>

<style>
  :global(body) {
    overflow: auto;
  }

  .server-page {
    min-height: 100vh;
    padding: 32px;
    display: grid;
    gap: 20px;
    background:
      radial-gradient(circle at top left, color-mix(in srgb, var(--c-accent) 20%, transparent), transparent 36%),
      linear-gradient(180deg, color-mix(in srgb, var(--c-surface-1) 84%, var(--c-bg)), var(--c-bg));
  }

  .panel-frame {
    border: 1px solid color-mix(in srgb, var(--c-border) 72%, transparent);
    border-radius: 22px;
    background: color-mix(in srgb, var(--c-surface-1) 82%, var(--c-bg));
    box-shadow: 0 24px 60px color-mix(in srgb, var(--c-bg) 55%, transparent);
  }

  .hero {
    padding: 28px;
    display: grid;
    gap: 20px;
    grid-template-columns: minmax(0, 1.6fr) minmax(260px, 0.9fr);
  }

  .eyebrow {
    margin: 0 0 10px;
    color: var(--c-text-2);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 0.74rem;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    font-size: clamp(2rem, 4vw, 3.4rem);
    line-height: 0.98;
  }

  h2 {
    font-size: 1.2rem;
  }

  .lede {
    margin-top: 14px;
    max-width: 62ch;
    color: color-mix(in srgb, var(--c-text-1) 78%, white);
  }

  .meta-grid,
  .content-grid {
    display: grid;
    gap: 14px;
  }

  .meta-grid {
    margin-top: 18px;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  }

  .meta-card {
    padding: 14px;
    border-radius: 16px;
    background: color-mix(in srgb, var(--c-surface-2) 80%, transparent);
    border: 1px solid color-mix(in srgb, var(--c-border) 40%, transparent);
  }

  .meta-card span {
    display: block;
    margin-bottom: 10px;
    font-size: 0.76rem;
    color: color-mix(in srgb, var(--c-text-1) 65%, transparent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .hero-brand {
    display: grid;
    align-content: center;
    gap: 12px;
  }

  .logo-wrap {
    min-height: 240px;
    border-radius: 20px;
    display: grid;
    place-items: center;
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--c-accent) 24%, transparent), transparent 60%),
      color-mix(in srgb, var(--c-surface-2) 85%, var(--c-bg));
    border: 1px solid color-mix(in srgb, var(--c-border) 35%, transparent);
  }

  .logo-wrap img {
    width: min(210px, 100%);
    height: auto;
    filter: drop-shadow(0 18px 30px color-mix(in srgb, var(--c-bg) 52%, transparent));
  }

  .signal-chip,
  .status-pill {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    min-height: 30px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--c-accent) 55%, transparent);
    background: color-mix(in srgb, var(--c-accent) 10%, var(--c-surface-2));
    color: var(--c-text-1);
    font-size: 0.8rem;
  }

  .content-grid {
    grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
  }

  .register-panel,
  .notes-panel {
    padding: 22px;
  }

  .panel-heading {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 18px;
  }

  .register-table {
    display: grid;
    gap: 10px;
  }

  .register-row {
    display: grid;
    gap: 12px;
    grid-template-columns: 70px minmax(0, 1fr) auto;
    align-items: center;
    padding: 14px 16px;
    border-radius: 16px;
    background: color-mix(in srgb, var(--c-surface-2) 72%, transparent);
    border: 1px solid color-mix(in srgb, var(--c-border) 25%, transparent);
  }

  .address {
    color: var(--c-text-2);
    font-variant-numeric: tabular-nums;
  }

  .name {
    color: color-mix(in srgb, var(--c-text-1) 82%, white);
  }

  ul {
    margin: 16px 0 0;
    padding-left: 18px;
    color: color-mix(in srgb, var(--c-text-1) 78%, white);
  }

  li + li {
    margin-top: 10px;
  }

  @media (max-width: 860px) {
    .server-page {
      padding: 18px;
    }

    .hero,
    .content-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
