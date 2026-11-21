/**
 * The path this plugin's HTTP surface owns, shared by both halves.
 *
 * One constant rather than a copy in each half: the page and the route are
 * built separately, and a rename that reached only one of them would leave a
 * page that loads and then silently 404s.
 */
export const HTTP_API_PREFIX = '/dsh-boost/api'
