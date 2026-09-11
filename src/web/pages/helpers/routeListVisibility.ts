import { normalizeTokenRouteMode } from '../../../shared/tokenRouteContract.js';

export type RouteListVisibilityItem = {
  id: number;
  modelPattern: string;
  displayName?: string | null;
  routeMode?: string | null;
  sourceRouteIds?: number[];
  enabled: boolean;
  kind?: string;
  readOnly?: boolean;
  isVirtual?: boolean;
};

function normalizeRouteMode(routeMode: string | null | undefined): 'pattern' | 'explicit_group' {
  return normalizeTokenRouteMode(routeMode);
}

function isExplicitGroupRoute(route: Pick<RouteListVisibilityItem, 'routeMode'>): boolean {
  return normalizeRouteMode(route.routeMode) === 'explicit_group';
}

export function buildVisibleRouteList<T extends RouteListVisibilityItem>(
  routes: T[],
  isExactModelPattern: (pattern: string) => boolean,
  matchesModelPattern: (model: string, pattern: string) => boolean,
): T[] {
  const coveringGroups = routes.filter((route) => (
    route.enabled
    && (
      ((isExplicitGroupRoute(route) || (route.sourceRouteIds || []).length > 0) && (route.sourceRouteIds || []).length > 0)
      || (!isExplicitGroupRoute(route) && !isExactModelPattern(route.modelPattern))
    )
  ));

  if (coveringGroups.length === 0) return routes;

  return routes.filter((route) => {
    if (isExplicitGroupRoute(route) || (route.sourceRouteIds || []).length > 0) return true;
    if (!isExactModelPattern(route.modelPattern)) return true;
    if (!route.enabled && route.kind !== 'zero_channel' && route.readOnly !== true && route.isVirtual !== true) return true;

    const exactModel = (route.modelPattern || '').trim();
    if (!exactModel) return true;

    return !coveringGroups.some((groupRoute) => {
      if (groupRoute.id === route.id) return false;
      // Management grouping follows membership, regardless of alias collisions
      // or whether a source model has its own display name.
      if (isExplicitGroupRoute(groupRoute)) {
        return (groupRoute.sourceRouteIds || []).includes(route.id);
      }
      return matchesModelPattern(exactModel, groupRoute.modelPattern);
    });
  });
}
