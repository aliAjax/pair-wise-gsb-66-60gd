<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { useTrackStore } from './stores/track'

const route = useRoute()
const store = useTrackStore()
const batchMessage = ref('')
const title = computed(() => route.name === 'track' ? '区段里程与缺陷分布' : route.name === 'workOrders' ? '整治任务与复测' : route.name === 'audit' ? '整治审计' : '轨道缺陷总览')
function recover() {
  batchMessage.value = store.recoverPendingBatches().message
}
</script>

<template>
  <v-app>
    <aside class="shell-nav">
      <div class="brand"><strong>轨</strong><div><b>轨道几何整治台</b><span>缺陷派工、复测与限速联查</span></div></div>
      <nav>
        <RouterLink to="/"><span>缺陷总览</span><small>{{ store.filtered.length }} 项</small></RouterLink>
        <RouterLink to="/track"><span>里程与区段</span><small>{{ store.pendingRestorations.length ? `${store.pendingRestorations.length} 待复核` : 'Canvas' }}</small></RouterLink>
        <RouterLink to="/work-orders"><span>整治复测</span><small>{{ store.defects.filter((item) => item.status !== '已关闭').length }} 项</small></RouterLink>
        <RouterLink to="/audit"><span>审计追溯</span><small>{{ store.audit.length }} 条</small></RouterLink>
      </nav>
      <div class="aside-data"><span>数据接入</span><strong>轨检车数据已导入</strong><small>本地持久化 / 可离线补录</small></div>
    </aside>
    <v-main class="shell-main">
      <header class="top"><div><span>工务调度中心 / 轨道几何</span><h1>{{ title }}</h1></div><div><small>线别</small><strong>京广上行 / 沪昆下行</strong></div></header>
      <div v-if="store.pendingBatches.length" class="batch-banner">
        <span>批次 {{ store.pendingBatches.map((item) => item.batchId).join('、') }} 写入失败，完整批次已留存。</span>
        <v-btn size="small" color="warning" @click="recover">从完整批次恢复并继续</v-btn>
        <small v-if="batchMessage">{{ batchMessage }}</small>
      </div>
      <RouterView />
    </v-main>
  </v-app>
</template>

<style scoped>
.batch-banner { display: flex; align-items: center; gap: 12px; padding: 10px 28px; background: #fdf3e3; border-bottom: 1px solid #e8d9b8; color: #7a5c1e; font-size: 12px; }
.batch-banner small { color: #8a7a52; }
</style>
