<svelte:options runes={true} />

<div class="spinner">
  <div class="spinner-ring"></div>
  <p class="spinner-text">Loading Modbus Lab...</p>
</div>

<style>
  .spinner {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background: var(--c-bg);
  }

  .spinner-text {
    margin-top: 20px;
    font-size: 14px;
    color: var(--c-text-2);
    letter-spacing: 0.5px;
  }

  .spinner-ring {
    display: inline-block;
    position: relative;
    width: 48px;
    height: 48px;
  }

  .spinner-ring::after {
    content: "";
    position: absolute;
    left: 7px;
    top: 7px;
    width: 34px;
    height: 34px;
    border: 3px solid var(--c-border);
    border-radius: 50%;
    border-color: var(--c-accent) transparent transparent transparent;
    animation: spinner-spin 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  }

  @keyframes spinner-spin {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(360deg);
    }
  }
</style>
