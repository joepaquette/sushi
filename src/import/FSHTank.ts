import { FSHDocument } from './FSHDocument';
import {
  Profile,
  Extension,
  Logical,
  Resource,
  Instance,
  FshValueSet,
  FshCodeSystem,
  Invariant,
  RuleSet,
  Mapping,
  Configuration,
  FshCode
} from '../fshtypes';
import { AssignmentRule, CaretValueRule } from '../fshtypes/rules';
import { Type, Metadata, Fishable } from '../utils/Fishable';
import {
  applyInsertRules,
  getUrlFromFshDefinition,
  getVersionFromFshDefinition,
  LOGICAL_TARGET_EXTENSION,
  TYPE_CHARACTERISTICS_EXTENSION
} from '../fhirtypes/common';
import flatMap from 'lodash/flatMap';

export class FSHTank implements Fishable {
  constructor(public readonly docs: FSHDocument[], public readonly config: Configuration) {}

  /**
   * Gets all profiles in the tank
   * @returns {Profile[]}
   */
  public getAllProfiles(): Profile[] {
    return flatMap(this.docs, doc => Array.from(doc.profiles.values()));
  }

  /**
   * Gets all extensions in the tank
   * @returns {Extension[]}
   */
  public getAllExtensions(): Extension[] {
    return flatMap(this.docs, doc => Array.from(doc.extensions.values()));
  }

  /**
   * Gets all logical models in the tank
   * @returns {Logical[]}
   */
  public getAllLogicals(): Logical[] {
    return flatMap(this.docs, doc => Array.from(doc.logicals.values()));
  }

  /**
   * Gets all resources in the tank
   * @returns {Resource[]}
   */
  public getAllResources(): Resource[] {
    return flatMap(this.docs, doc => Array.from(doc.resources.values()));
  }

  /**
   * Gets all instances in the tank
   * @returns {Instance[]}
   */
  public getAllInstances(): Instance[] {
    return flatMap(this.docs, doc => Array.from(doc.instances.values()));
  }

  /**
   * Gets all structure definitions (i.e., FshStructures) (profiles, extensions,
   * logical models, and resources) in the tank.
   * @returns {(Profile | Extension)[]}
   */
  public getAllStructureDefinitions(): (Profile | Extension | Logical | Resource)[] {
    return [
      ...this.getAllProfiles(),
      ...this.getAllExtensions(),
      ...this.getAllLogicals(),
      ...this.getAllResources()
    ];
  }

  /**
   * Gets all value sets in the tank
   * @returns {FshValueSet[]}
   */
  public getAllValueSets(): FshValueSet[] {
    return flatMap(this.docs, doc => Array.from(doc.valueSets.values()));
  }

  /**
   * Gets all code systems in the tank
   * @returns {FshCodeSystem[]}
   */
  public getAllCodeSystems(): FshCodeSystem[] {
    return flatMap(this.docs, doc => Array.from(doc.codeSystems.values()));
  }

  /**
   * Gets all invariants in the tank
   * @returns {Invariant[]}
   */
  public getAllInvariants(): Invariant[] {
    return flatMap(this.docs, doc => Array.from(doc.invariants.values()));
  }

  /**
   * Gets all ruleSets in the tank
   * @returns {RuleSet[]}
   */
  public getAllRuleSets(): RuleSet[] {
    return flatMap(this.docs, doc => Array.from(doc.ruleSets.values()));
  }

  /**
   * Gets all Mappings in the tank
   * @returns {Mapping[]}
   */
  public getAllMappings(): Mapping[] {
    return flatMap(this.docs, doc => Array.from(doc.mappings.values()));
  }

  /**
   * Finds the alias in the tank, if it exists
   * @param {string} name - The name of the alias we're looking for
   * @returns {string | undefined}
   */
  public resolveAlias(name: string): string | undefined {
    for (const doc of this.docs) {
      const foundAlias = doc.aliases.get(name);
      if (foundAlias) return foundAlias;
    }
    return undefined;
  }

  fish(
    item: string,
    ...types: Type[]
  ):
    | Profile
    | Extension
    | Logical
    | Resource
    | FshValueSet
    | FshCodeSystem
    | Instance
    | Invariant
    | RuleSet
    | Mapping
    | undefined {
    // Resolve alias if necessary
    item = this.resolveAlias(item) ?? item;

    // version needs to be checked separately from the base
    const [base, ...versionParts] = item?.split('|') ?? ['', ''];
    const version = versionParts.join('|') || null;

    // No types passed in means to search ALL supported types
    if (types.length === 0) {
      types = [
        Type.Profile,
        Type.Extension,
        Type.Logical,
        Type.Resource,
        Type.ValueSet,
        Type.CodeSystem,
        Type.Instance,
        Type.Invariant,
        Type.RuleSet,
        Type.Mapping
      ];
    }

    for (const t of types) {
      let result;
      switch (t) {
        case Type.Profile:
          result = this.getAllProfiles().find(
            p =>
              (p.name === base ||
                p.id === base ||
                getUrlFromFshDefinition(p, this.config.canonical) === base) &&
              (version == null || version === getVersionFromFshDefinition(p, this.config.version))
          );
          if (!result) {
            result = this.getAllInstances().find(
              profileInstance =>
                profileInstance.instanceOf === 'StructureDefinition' &&
                profileInstance.usage === 'Definition' &&
                (profileInstance.name === base ||
                  profileInstance.id === base ||
                  getUrlFromFshDefinition(profileInstance, this.config.canonical) === base) &&
                (version == null ||
                  version === getVersionFromFshDefinition(profileInstance, this.config.version)) &&
                profileInstance.rules.some(
                  rule =>
                    rule instanceof AssignmentRule &&
                    rule.path === 'derivation' &&
                    rule.value instanceof FshCode &&
                    rule.value.code === 'constraint'
                ) &&
                !profileInstance.rules.some(
                  rule =>
                    rule instanceof AssignmentRule &&
                    rule.path === 'type' &&
                    rule.value === 'Extension'
                )
            );
          }
          break;
        case Type.Extension:
          result = this.getAllExtensions().find(
            e =>
              (e.name === base ||
                e.id === base ||
                getUrlFromFshDefinition(e, this.config.canonical) === base) &&
              (version == null || version === getVersionFromFshDefinition(e, this.config.version))
          );
          if (!result) {
            // There may be a matching definitional Instance of StructureDefinition with type Extension
            result = this.getAllInstances().find(
              extensionInstance =>
                extensionInstance.instanceOf === 'StructureDefinition' &&
                extensionInstance.usage === 'Definition' &&
                (extensionInstance.name === base ||
                  extensionInstance.id === base ||
                  getUrlFromFshDefinition(extensionInstance, this.config.canonical) === base) &&
                (version == null ||
                  version ===
                    getVersionFromFshDefinition(extensionInstance, this.config.version)) &&
                extensionInstance.rules.some(
                  rule =>
                    rule instanceof AssignmentRule &&
                    rule.path === 'derivation' &&
                    rule.value instanceof FshCode &&
                    rule.value.code === 'constraint'
                ) &&
                extensionInstance.rules.some(
                  rule =>
                    rule instanceof AssignmentRule &&
                    rule.path === 'type' &&
                    rule.value === 'Extension'
                )
            );
          }
          break;
        case Type.Logical:
          result = this.getAllLogicals().find(
            l =>
              (l.name === base ||
                l.id === base ||
                getUrlFromFshDefinition(l, this.config.canonical) === base) &&
              (version == null || version === getVersionFromFshDefinition(l, this.config.version))
          );
          if (!result) {
            result = this.getAllInstances().find(
              logicalInstance =>
                logicalInstance.instanceOf === 'StructureDefinition' &&
                logicalInstance.usage === 'Definition' &&
                (logicalInstance.name === base ||
                  logicalInstance.id === base ||
                  getUrlFromFshDefinition(logicalInstance, this.config.canonical) === base) &&
                (version == null ||
                  version === getVersionFromFshDefinition(logicalInstance, this.config.version)) &&
                logicalInstance.rules.some(
                  rule =>
                    rule instanceof AssignmentRule &&
                    rule.path === 'derivation' &&
                    rule.value instanceof FshCode &&
                    rule.value.code === 'specialization'
                ) &&
                logicalInstance.rules.some(
                  rule =>
                    rule instanceof AssignmentRule &&
                    rule.path === 'kind' &&
                    rule.value instanceof FshCode &&
                    rule.value.code === 'logical'
                )
            );
          }
          break;
        case Type.Resource:
          result = this.getAllResources().find(
            r =>
              (r.name === base ||
                r.id === base ||
                getUrlFromFshDefinition(r, this.config.canonical) === base) &&
              (version == null || version === getVersionFromFshDefinition(r, this.config.version))
          );
          if (!result) {
            result = this.getAllInstances().find(
              resourceInstance =>
                resourceInstance.instanceOf === 'StructureDefinition' &&
                resourceInstance.usage === 'Definition' &&
                (resourceInstance.name === base ||
                  resourceInstance.id === base ||
                  getUrlFromFshDefinition(resourceInstance, this.config.canonical) === base) &&
                (version == null ||
                  version === getVersionFromFshDefinition(resourceInstance, this.config.version)) &&
                resourceInstance.rules.some(
                  rule =>
                    rule instanceof AssignmentRule &&
                    rule.path === 'derivation' &&
                    rule.value instanceof FshCode &&
                    rule.value.code === 'specialization'
                ) &&
                resourceInstance.rules.some(
                  rule =>
                    rule instanceof AssignmentRule &&
                    rule.path === 'kind' &&
                    rule.value instanceof FshCode &&
                    rule.value.code === 'resource'
                )
            );
          }
          break;
        case Type.ValueSet:
          result = this.getAllValueSets().find(
            vs =>
              (vs.name === base ||
                vs.id === base ||
                getUrlFromFshDefinition(vs, this.config.canonical) === base) &&
              (version == null || version === getVersionFromFshDefinition(vs, this.config.version))
          );
          if (!result) {
            result = this.getAllInstances().find(
              vsInstance =>
                vsInstance?.instanceOf === 'ValueSet' &&
                vsInstance?.usage === 'Definition' &&
                (vsInstance?.name === base ||
                  vsInstance.id === base ||
                  getUrlFromFshDefinition(vsInstance, this.config.canonical) === base) &&
                (version == null ||
                  version === getVersionFromFshDefinition(vsInstance, this.config.version))
            );
          }
          break;
        case Type.CodeSystem:
          result = this.getAllCodeSystems().find(
            cs =>
              (cs.name === base ||
                cs.id === base ||
                getUrlFromFshDefinition(cs, this.config.canonical) === base) &&
              (version == null || version === getVersionFromFshDefinition(cs, this.config.version))
          );
          if (!result) {
            result = this.getAllInstances().find(
              csInstance =>
                csInstance?.instanceOf === 'CodeSystem' &&
                csInstance?.usage === 'Definition' &&
                (csInstance?.name === base ||
                  csInstance.id === base ||
                  getUrlFromFshDefinition(csInstance, this.config.canonical) === base) &&
                (version == null ||
                  version === getVersionFromFshDefinition(csInstance, this.config.version))
            );
          }
          break;
        case Type.Instance:
          result = this.getAllInstances().find(
            i =>
              (i.name === base || i.id === base) &&
              (version == null || version === getVersionFromFshDefinition(i, this.config.version))
          );
          break;
        case Type.Invariant:
          result = this.getAllInvariants().find(i => i.name === base);
          break;
        case Type.RuleSet:
          result = this.getAllRuleSets().find(r => r.name === base);
          break;
        case Type.Mapping:
          result = this.getAllMappings().find(m => m.name === base);
          break;
        case Type.Type:
        default:
          // Tank doesn't support these types
          break;
      }
      if (result != null) {
        return result;
      }
    }
    // No match, return undefined
    return;
  }

  fishForAppliedRuleSet(item: string): RuleSet | undefined {
    for (const doc of this.docs) {
      const ruleSet = doc.appliedRuleSets.get(item);
      if (ruleSet) {
        return ruleSet;
      }
    }
  }

  fishForMetadata(item: string, ...types: Type[]): Metadata | undefined {
    const result = this.fish(item, ...types);
    if (result) {
      applyInsertRules(result, this);
      const meta: Metadata = {
        id: result.id,
        name: result.name
      };
      if (
        result instanceof Profile ||
        result instanceof Extension ||
        result instanceof Logical ||
        result instanceof Resource
      ) {
        meta.url = getUrlFromFshDefinition(result, this.config.canonical);
        meta.parent = result.parent;
        meta.resourceType = 'StructureDefinition';
        if (result instanceof Logical) {
          // Logical models should always use an absolute URL as their StructureDefinition.type
          // unless HL7 published them. In that case, the URL is relative to
          // http://hl7.org/fhir/StructureDefinition/.
          // Ref: https://chat.fhir.org/#narrow/stream/179177-conformance/topic/StructureDefinition.2Etype.20for.20Logical.20Models.2FCustom.20Resources/near/240488388
          const HL7_URL = 'http://hl7.org/fhir/StructureDefinition/';
          meta.sdType = meta.url.startsWith(HL7_URL) ? meta.url.slice(HL7_URL.length) : meta.url;
          meta.canBeTarget = hasLogicalCharacteristic(result, 'can-be-target');
          meta.canBind = hasLogicalCharacteristic(result, 'can-bind');
        }
      } else if (result instanceof FshValueSet || result instanceof FshCodeSystem) {
        meta.url = getUrlFromFshDefinition(result, this.config.canonical);
        if (result instanceof FshValueSet) {
          meta.resourceType = 'ValueSet';
        } else {
          meta.resourceType = 'CodeSystem';
        }
      } else if (result instanceof Instance) {
        result.rules?.forEach(r => {
          if (r.path === 'url' && r instanceof AssignmentRule && typeof r.value === 'string') {
            meta.url = r.value;
            // don't break; keep looping in case there is a later rule that re-assigns url
          }
        });
        meta.instanceUsage = result.usage;
      }
      return meta;
    }
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fishForFHIR(item: string, ...types: Type[]): any | undefined {
    // the FSHTank cannot return FHIR definitions, but we define this function
    // in order to implement the Fishable interface
  }
}

function hasLogicalCharacteristic(logical: Logical, code: string) {
  if (logical.characteristics.includes(code)) {
    return true;
  } else {
    // * ^extension[0].url = "http://hl7.org/fhir/StructureDefinition/structuredefinition-type-characteristics"
    // * ^extension[0].valueCode = #can-be-target
    // or
    // * ^extension[0].url = "http://hl7.org/fhir/tools/StructureDefinition/logical-target"
    // * ^extension[0].valueBoolean = true
    // - give me every caret rule where path is empty and caretPath is extension.url or extension\[\d+\].url
    // - for each index, tell me what the last url is. so now we have a mapping of "index" to "url"
    // - filter that down to indices where the url is the one i want. so now i have the indices to check.
    // - now, give me every caret rule with no path, caretPath is extension.valueWhatever, and the index is in my list
    // - for each index, tell me what the last value is. that's the actual value.
    // - if one of them has The Value I Seek, then the overall condition is true
    // - otherwise, the overall condition is false
    const extensionUrlRules = logical.rules.filter(rule => {
      return (
        rule instanceof CaretValueRule &&
        rule.path === '' &&
        /^extension(\[\d+\])?\.url$/.test(rule.caretPath)
      );
    }) as CaretValueRule[];
    const extensionUrls = new Map<number, string>();
    extensionUrlRules.forEach(urlRule => {
      const match = urlRule.caretPath.match(/^extension(\[(\d+)\])?\.url$/);
      if (match?.[2]) {
        extensionUrls.set(parseInt(match[2]), urlRule.value.toString());
      } else {
        extensionUrls.set(0, urlRule.value.toString());
      }
    });
    for (const [idx, url] of extensionUrls.entries()) {
      if (url === TYPE_CHARACTERISTICS_EXTENSION) {
        const caretPaths = [`extension[${idx}].valueCode`];
        if (idx === 0) {
          caretPaths.push('extension.valueCode');
        }
        const valueRule = logical.rules
          .filter(rule => {
            return (
              rule instanceof CaretValueRule &&
              rule.path === '' &&
              caretPaths.includes(rule.caretPath)
            );
          })
          .pop() as CaretValueRule;
        if (valueRule && valueRule.value instanceof FshCode && valueRule.value.code === code) {
          return true;
        }
      } else if (url === LOGICAL_TARGET_EXTENSION && code === 'can-be-target') {
        const caretPaths = [`extension[${idx}].valueBoolean`];
        if (idx === 0) {
          caretPaths.push('extension.valueBoolean');
        }
        const valueRule = logical.rules
          .filter(rule => {
            return (
              rule instanceof CaretValueRule &&
              rule.path === '' &&
              caretPaths.includes(rule.caretPath)
            );
          })
          .pop() as CaretValueRule;
        if (valueRule?.value === true) {
          return true;
        }
      }
    }
  }
  return false;
}
