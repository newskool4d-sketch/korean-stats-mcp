/**
 * 캐시 매니저
 * 메모리 캐시를 사용하여 KOSIS API 호출을 최적화
 */

import NodeCache from 'node-cache';
import { config } from '../config/index.js';

// 캐시 TTL 설정 (초 단위)
const TTL = {
  STATISTICS_LIST: 24 * 60 * 60,      // 목록: 24시간
  STATISTICS_DATA: 6 * 60 * 60,        // 데이터: 6시간
  SEARCH_RESULTS: 1 * 60 * 60,         // 검색: 1시간
  EXPLANATION: 7 * 24 * 60 * 60,       // 설명: 7일
  TABLE_META: 24 * 60 * 60,            // 테이블 메타: 24시간
  // 빈 결과: KOSIS 일시 장애로 0건이 왔을 때 6시간 고착되지 않도록 짧게
  EMPTY_RESULT: 60,
} as const;

class CacheManager {
  private cache: NodeCache;
  private readonly maxKeys: number;
  private readonly maxRetainedBytes: number;
  private readonly accessOrder = new Map<string, true>();
  private readonly valueBytes = new Map<string, number>();
  private retainedBytes = 0;
  // 동일 키 동시 요청 dedup — chain 도구가 같은 (지표×지역)을 병렬 호출할 때
  // 캐시 미스 stampede로 KOSIS 중복 호출되는 것을 방지 (promise 공유)
  private inflight = new Map<string, Promise<unknown>>();

  constructor(
    maxKeys: number = config.cache.maxKeys,
    maxRetainedBytes: number = config.cache.maxRetainedBytes
  ) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys <= 0) {
      throw new Error('Cache maxKeys must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes <= 0) {
      throw new Error('Cache maxRetainedBytes must be a positive safe integer.');
    }
    this.maxKeys = maxKeys;
    this.maxRetainedBytes = maxRetainedBytes;
    this.cache = new NodeCache({
      stdTTL: config.cache.ttlHours * 60 * 60,
      checkperiod: 600, // 10분마다 만료 체크
      maxKeys,
      useClones: false, // 성능을 위해 복제 비활성화
    });
    this.cache.on('del', (key: string) => this.forget(key));
    this.cache.on('expired', (key: string) => this.forget(key));
  }

  private estimateRetainedBytes(value: unknown): number {
    if (value instanceof Uint8Array) return value.byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    try {
      const serialized = JSON.stringify(value);
      return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
    } catch {
      return this.maxRetainedBytes + 1;
    }
  }

  private forget(key: string): void {
    const bytes = this.valueBytes.get(key);
    if (bytes !== undefined) {
      this.retainedBytes = Math.max(0, this.retainedBytes - bytes);
      this.valueBytes.delete(key);
    }
    this.accessOrder.delete(key);
  }

  private touch(key: string): void {
    this.accessOrder.delete(key);
    this.accessOrder.set(key, true);
  }

  private evictLeastRecentlyUsed(newKey: string, newValueBytes: number): void {
    if (this.cache.has(newKey)) return;
    while (
      this.cache.getStats().keys >= this.maxKeys ||
      this.retainedBytes + newValueBytes > this.maxRetainedBytes
    ) {
      const trackedOldest = this.accessOrder.keys().next().value as string | undefined;
      const oldest = trackedOldest ?? this.cache.keys()[0];
      if (!oldest) break;
      this.cache.del(oldest);
    }
  }

  /**
   * 캐시 키 생성
   */
  private generateKey(prefix: string, params: Record<string, unknown>): string {
    const sortedParams = Object.keys(params)
      .sort()
      .map((k) => `${k}=${JSON.stringify(params[k])}`)
      .join('&');
    return `${prefix}:${sortedParams}`;
  }

  /**
   * 캐시에서 데이터 조회 또는 fetcher 실행
   */
  async getOrFetch<T>(
    prefix: string,
    params: Record<string, unknown>,
    fetcher: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    const key = this.generateKey(prefix, params);

    // 캐시에서 조회
    const cached = this.cache.get<T>(key);
    if (cached !== undefined) {
      this.touch(key);
      return cached;
    }

    // 동일 키 in-flight 요청이 있으면 그 promise 공유 (stampede 방지)
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = (async () => {
      try {
        const data = await fetcher();
        // 빈 배열은 일시 장애일 수 있음 — 짧은 TTL로만 캐시 (장기 고착 방지)
        const isEmpty = Array.isArray(data) && data.length === 0;
        const valueBytes = this.estimateRetainedBytes(data);
        if (valueBytes <= this.maxRetainedBytes) {
          this.evictLeastRecentlyUsed(key, valueBytes);
          this.cache.set(
            key,
            data,
            isEmpty ? TTL.EMPTY_RESULT : (ttl ?? config.cache.ttlHours * 60 * 60)
          );
          this.valueBytes.set(key, valueBytes);
          this.retainedBytes += valueBytes;
          this.touch(key);
        }
        return data;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * 통계 목록 캐시
   */
  async getStatisticsList<T>(
    params: Record<string, unknown>,
    fetcher: () => Promise<T>
  ): Promise<T> {
    return this.getOrFetch('list', params, fetcher, TTL.STATISTICS_LIST);
  }

  /**
   * 통계 데이터 캐시
   */
  async getStatisticsData<T>(
    params: Record<string, unknown>,
    fetcher: () => Promise<T>
  ): Promise<T> {
    return this.getOrFetch('data', params, fetcher, TTL.STATISTICS_DATA);
  }

  /**
   * 검색 결과 캐시
   */
  async getSearchResults<T>(
    params: Record<string, unknown>,
    fetcher: () => Promise<T>
  ): Promise<T> {
    return this.getOrFetch('search', params, fetcher, TTL.SEARCH_RESULTS);
  }

  /**
   * 통계 설명 캐시
   */
  async getExplanation<T>(
    params: Record<string, unknown>,
    fetcher: () => Promise<T>
  ): Promise<T> {
    return this.getOrFetch('explain', params, fetcher, TTL.EXPLANATION);
  }

  /**
   * 테이블 메타데이터 캐시
   */
  async getTableMeta<T>(
    params: Record<string, unknown>,
    fetcher: () => Promise<T>
  ): Promise<T> {
    return this.getOrFetch('meta', params, fetcher, TTL.TABLE_META);
  }

  /**
   * 캐시 통계
   */
  getStats() {
    return {
      ...this.cache.getStats(),
      retainedBytes: this.retainedBytes,
      maxRetainedBytes: this.maxRetainedBytes,
    };
  }

  /**
   * 캐시 초기화
   */
  flush() {
    this.cache.flushAll();
    this.accessOrder.clear();
    this.valueBytes.clear();
    this.retainedBytes = 0;
  }
}

// 싱글톤 인스턴스
let cacheInstance: CacheManager | null = null;

export function getCacheManager(): CacheManager {
  if (!cacheInstance) {
    cacheInstance = new CacheManager();
  }
  return cacheInstance;
}

export { CacheManager, TTL };
