# [1.1.0](https://github.com/CoCreateJS/db/compare/v1.0.0...v1.1.0) (2026-11-22)


### Bug Fixes

* Add scope resolution benchmarks and reporting ([a12e3cb](https://github.com/CoCreateJS/db/commit/a12e3cbe957c30e8e0159719ce44be220fe669fd))
* consume existing dot notation utility API ([81932dc](https://github.com/CoCreateJS/db/commit/81932dc67061c6d3ddafe4f2ce3de6488d184495))
* **db:** align indexed queries with strict utils semantics ([4dccde1](https://github.com/CoCreateJS/db/commit/4dccde14ba2f645043954617648d7a75be326dfa))
* optimize index value handling in createRecord and flattenIndexValues ([eb6f63f](https://github.com/CoCreateJS/db/commit/eb6f63fdbfd29a85bf64f2156ad3c52f77269d35))
* restore scope-aware DB entry points ([f6dc6d8](https://github.com/CoCreateJS/db/commit/f6dc6d8f00ac0d7fc30b57360989d48c8fd4456f))


### Features

* add configurable artifact scopes ([0036d5e](https://github.com/CoCreateJS/db/commit/0036d5e57098987ced094709eb78c1435237e2ad))
* adopt flat UUID artifact database model ([1b5d178](https://github.com/CoCreateJS/db/commit/1b5d178d8a6198d3f8c891a660a72b39e7cf878f))
* **crud:** implement update function for artifact management ([2955244](https://github.com/CoCreateJS/db/commit/2955244dea8f32f0a7ebc16108239a82e721f58a))
* **db:** checkpoint live artifacts and local residency ([0191af0](https://github.com/CoCreateJS/db/commit/0191af01a9abd26ff2ae553fa4d04a7cf953daa8))
* **db:** checkpoint pressure-driven disk residency ([7d9c347](https://github.com/CoCreateJS/db/commit/7d9c347d0385de84d9aefa6acbb00dafec9edaa7))


### Performance Improvements

* streamline DB index traversal and grouping ([a2e59a9](https://github.com/CoCreateJS/db/commit/a2e59a9d5b3257f9d21a5101d0461042675ecb5a))

# 1.0.0 (2026-11-14)


### Bug Fixes

* cache DB files on demand and validate query and update operators ([5ccb279](https://github.com/CoCreateJS/db/commit/5ccb279294b234cab14ee83317e0fb7fd155b7c1))
* checkpoint CoCreateDB storage and module updates ([466ccb7](https://github.com/CoCreateJS/db/commit/466ccb79472d5516ab63fb9f85b52f6e358f1257))
* preserve live DB state and deliver resolved update documents ([ca71ca0](https://github.com/CoCreateJS/db/commit/ca71ca01e76b2f65f08272351cdd70710b387a0f))
* reduce write-path copies and holder lookups ([8e78687](https://github.com/CoCreateJS/db/commit/8e78687eaff65f121932480dfc5859ed7f229a9a))


### Features

* add distributed availability index ([94be4a9](https://github.com/CoCreateJS/db/commit/94be4a9d37b298991b614503efc0a44aaccd4d99))
* expand filesystem CRUD and distributed indexes ([1679dce](https://github.com/CoCreateJS/db/commit/1679dce46420c840652aa8ad5189cdb5e787475b))
* highlight distributed data support ([60c1d25](https://github.com/CoCreateJS/db/commit/60c1d259c44eb7d747f10ee0528fc9c428d1182c))
* launch CoCreateDB document database ([5032be3](https://github.com/CoCreateJS/db/commit/5032be39ebef6f54e4f66ebed3a4bfcfd7d65e1a))
* unify update patches and split local and peer distribution ([cb6aac3](https://github.com/CoCreateJS/db/commit/cb6aac336e7d8fe8ece49c26333fc07a02b00ee8))

# Changelog

This project is a new module based on the CoCreate Authenticate starter.

Releases will be recorded here when they begin.
