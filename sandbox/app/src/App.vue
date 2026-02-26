<script setup lang="ts">
import { ref } from "vue";

const count = ref(0);
</script>

<template>
  <div style="font-family: sans-serif; max-width: 600px; margin: 40px auto; text-align: center;">
    <h1>Hello from the Sandbox!</h1>
    <p>Edit this component in the editor and save to see HMR in action.</p>
    <button @click="count++" style="font-size: 1.2rem; padding: 8px 20px; cursor: pointer;">
      Count: {{ count }}
    </button>
  </div>
</template>
