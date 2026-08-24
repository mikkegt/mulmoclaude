<script setup lang="ts">
/**
 * The plugin's real mounting condition: a Shadow DOM, with only the plugin's own CSS inside.
 *
 * MulmoTerminal mounts every plugin this way (`PluginFrame.vue` → `attachShadow({ mode: "open" })`)
 * and injects the plugin's compiled stylesheet into the shadow root. A stylesheet the component
 * appends to `document.head` at runtime does NOT cross that boundary — which is exactly the
 * question this demo exists to answer, so the toggle has to reproduce it faithfully.
 *
 * A shadow root is a separate tree, so the content is mounted as its own Vue app rather than
 * teleported: `provide`/`inject` walks the component chain, and re-rendering a slot into a
 * detached container breaks that chain. The runtime is therefore installed on the app created
 * here, exactly as a host installs it per plugin.
 */
import { createApp, onBeforeUnmount, onMounted, ref, type App, type Component } from "vue";
import { PLUGIN_RUNTIME_KEY, type BrowserPluginRuntime } from "gui-chat-protocol/vue";

const props = defineProps<{ css: string; runtime: BrowserPluginRuntime; component: Component; componentProps: Record<string, unknown> }>();

const host = ref<HTMLDivElement | null>(null);
let mounted: App | null = null;

onMounted(() => {
  const element = host.value;
  if (!element) return;
  const shadow = element.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = props.css;
  shadow.appendChild(style);
  const mount = document.createElement("div");
  // The host gives the isolated frame a light surface; match it so colours read the same.
  mount.style.cssText = "background:#ffffff;color:#111827;height:100%;overflow:hidden";
  shadow.appendChild(mount);
  mounted = createApp(props.component, props.componentProps);
  mounted.provide(PLUGIN_RUNTIME_KEY, props.runtime);
  mounted.mount(mount);
});

onBeforeUnmount(() => {
  mounted?.unmount();
  mounted = null;
});
</script>

<template>
  <div ref="host" class="h-full"></div>
</template>
