import { isEmpty } from 'lodash';
import {
  ElementDefinition,
  ElementDefinitionBindingStrength,
  idRegex,
  InstanceDefinition,
  StructureDefinition
} from '../fhirtypes';
import { Extension, Invariant, Logical, Profile } from '../fshtypes';
import { FSHTank } from '../import';
import { InstanceExporter } from '../export';
import {
  DuplicateSliceError,
  InvalidExtensionParentError,
  InvalidLogicalParentError,
  InvalidProfileParentError,
  InvalidFHIRIdError,
  ParentDeclaredAsNameError,
  ParentDeclaredAsIdError,
  ParentNotDefinedError,
  ParentNotProvidedError
} from '../errors';
import {
  AddElementRule,
  AssignmentRule,
  BindingRule,
  CardRule,
  CaretValueRule,
  ContainsRule,
  FlagRule,
  ObeysRule,
  OnlyRule,
  SdRule
} from '../fshtypes/rules';
import { Fishable, logger, MasterFisher, Metadata, resolveSoftIndexing, Type } from '../utils';
import {
  applyInsertRules,
  applyMixinRules,
  cleanResource,
  getUrlFromFshDefinition,
  replaceReferences,
  splitOnPathPeriods
} from '../fhirtypes/common';
import { Package } from './Package';

// Extensions that should not be inherited by derived profiles
// See: https://jira.hl7.org/browse/FHIR-27535
const UNINHERITED_EXTENSIONS = [
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status',
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-normative-version',
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-explicit-type-name',
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-fmm',
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-wg',
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-summary'
];

/**
 * The StructureDefinitionExporter is the class for exporting Logical models, Profiles, and Extensions.
 * The operations and structure of both exporters are very similar, so they currently share an exporter.
 */
export class StructureDefinitionExporter implements Fishable {
  deferredRules = new Map<StructureDefinition, CaretValueRule[]>();

  constructor(
    private readonly tank: FSHTank,
    private readonly pkg: Package,
    private readonly fisher: MasterFisher
  ) {}

  /**
   * Processes the fshDefinition's parent, validating it according to its type.
   * Returns the parent's StructureDefinition as the basis for the new StructureDefinition
   * for the provided fshDefinition.
   * @param {Extension | Profile | Logical} fshDefinition - The definition to do preprocessing on.
   *                                                        It is updated directly based on processing.
   * @returns {StructureDefinition} for this fshDefinition
   * @private
   */
  private getStructureDefinition(
    fshDefinition: Profile | Extension | Logical
  ): StructureDefinition {
    // Process/validate the fshDefinition.parent value with the purpose of
    // obtaining the parent's StructureDefinition as the basis for this
    // fshDefinition's StructureDefinition,

    if (isEmpty(fshDefinition.parent)) {
      // Handle cases where the parent is not specified by throwing an error
      // or setting an appropriate default according to the definition type
      if (fshDefinition instanceof Profile) {
        // Parent for a profile is required. Throw an error since one is not provided.
        throw new ParentNotProvidedError(fshDefinition.name, fshDefinition.sourceInfo);
      } else if (fshDefinition instanceof Extension) {
        fshDefinition.parent = 'Extension';
      } else if (fshDefinition instanceof Logical) {
        fshDefinition.parent = 'Element';
      }
    }
    const parentName = fshDefinition.parent;

    let defnType: Type;
    if (fshDefinition instanceof Extension) {
      defnType = Type.Extension;
    } else if (fshDefinition instanceof Logical) {
      defnType = Type.Logical;
    } else {
      defnType = Type.Resource;
    }

    if (fshDefinition.name === parentName) {
      const result = this.fishForMetadata(parentName, defnType);
      throw new ParentDeclaredAsNameError(
        fshDefinition.constructorName,
        fshDefinition.name,
        fshDefinition.sourceInfo,
        result?.url
      );
    }

    if (fshDefinition.id === parentName) {
      const result = this.fishForMetadata(parentName, defnType);
      throw new ParentDeclaredAsIdError(
        fshDefinition.constructorName,
        fshDefinition.name,
        fshDefinition.id,
        fshDefinition.sourceInfo,
        result?.url
      );
    }

    // Now that we have a valid parent name, retrieve its StructureDefinition.
    // Then make sure it is a valid StructureDefinition based on the type of
    // the fshDefinition.

    const parentJson = this.fishForFHIR(parentName);
    if (!parentJson) {
      // If parentJson is not defined, then the provided parent's StructureDefinition is not defined
      throw new ParentNotDefinedError(fshDefinition.name, parentName, fshDefinition.sourceInfo);
    }

    if (fshDefinition instanceof Profile && parentJson.kind === 'logical') {
      // A profile cannot have a logical model as a parent
      throw new InvalidProfileParentError(fshDefinition.name, parentName, fshDefinition.sourceInfo);
    } else if (fshDefinition instanceof Extension && parentJson.type !== 'Extension') {
      // An extension can only have an Extension as a parent
      throw new InvalidExtensionParentError(
        fshDefinition.name,
        parentName,
        fshDefinition.sourceInfo
      );
    } else if (
      fshDefinition instanceof Logical &&
      !(parentJson.kind === 'logical' || parentJson.type === 'Element')
    ) {
      // A logical model can only have another logical model as a parent
      // or it can have the Element resource as a parent
      throw new InvalidLogicalParentError(fshDefinition.name, parentName, fshDefinition.sourceInfo);
    }

    return StructureDefinition.fromJSON(parentJson);
  }

  /**
   * Sets the metadata for the StructureDefinition.  This includes clearing metadata that was copied from the parent
   * that may not be relevant to the child StructureDefinition.  Overall approach was discussed on Zulip.  This
   * function represents implementation of that approach plus setting extra metadata provided by FSH.
   * This essentially aligns closely with the approach that Forge uses (ensuring some consistency across tools).
   * @see {@link https://chat.fhir.org/#narrow/stream/179252-IG-creation/topic/Bad.20links.20on.20Detailed.20Description.20tab/near/186766845}
   * @param {StructureDefinition} structDef - The StructureDefinition to set metadata on
   * @param {Profile | Extension | Logical} fshDefinition - The definition we are exporting
   */
  private setMetadata(
    structDef: StructureDefinition,
    fshDefinition: Profile | Extension | Logical
  ): void {
    // First save the original URL, as that is the URL we'll want to set as the baseDefinition
    const baseURL = structDef.url;

    // Now set/clear elements in order of their appearance in Resource/DomainResource/StructureDefinition definitions
    structDef.setId(fshDefinition.id, fshDefinition.sourceInfo);
    delete structDef.meta;
    delete structDef.implicitRules;
    delete structDef.language;
    delete structDef.text;
    delete structDef.contained;
    structDef.extension = structDef.extension?.filter(e => !UNINHERITED_EXTENSIONS.includes(e.url));
    if (!structDef.extension?.length) {
      // for consistency, delete rather than leaving null-valued
      delete structDef.extension;
    }
    structDef.modifierExtension = structDef.modifierExtension?.filter(
      e => !UNINHERITED_EXTENSIONS.includes(e.url)
    );
    if (!structDef.modifierExtension?.length) {
      // for consistency, delete rather than leaving null-valued
      delete structDef.modifierExtension;
    }
    structDef.url = getUrlFromFshDefinition(fshDefinition, this.tank.config.canonical);
    delete structDef.identifier;
    structDef.version = this.tank.config.version; // can be overridden using a rule
    structDef.setName(fshDefinition.name, fshDefinition.sourceInfo);
    if (fshDefinition.title) {
      structDef.title = fshDefinition.title;
      if (
        fshDefinition instanceof Extension &&
        !(this.tank.config.applyExtensionMetadataToRoot === false)
      ) {
        structDef.elements[0].short = fshDefinition.title;
      }
    } else {
      delete structDef.title;
    }
    structDef.status = 'active'; // it's 1..1 so we have to set it to something; can be overridden w/ rule
    delete structDef.experimental;
    delete structDef.date;
    delete structDef.publisher;
    delete structDef.contact;
    if (fshDefinition.description) {
      structDef.description = fshDefinition.description;
      if (
        fshDefinition instanceof Extension &&
        !(this.tank.config.applyExtensionMetadataToRoot === false)
      ) {
        structDef.elements[0].definition = fshDefinition.description;
      }
    } else {
      delete structDef.description;
    }
    delete structDef.useContext;
    delete structDef.jurisdiction;
    delete structDef.purpose;
    delete structDef.copyright;
    delete structDef.keyword;
    // keep structDef.fhirVersion as that ought not change from parent to child
    // keep mapping since existing elements refer to the mapping and we're not removing those
    // keep kind since it should not change except for logical models
    if (fshDefinition instanceof Logical) {
      structDef.kind = 'logical';
    }
    structDef.abstract = false; // always reset to false, assuming most children of abstracts aren't abstract; can be overridden w/ rule
    // context and contextInvariant only apply to extensions.
    // keep context, assuming context is still valid for child extensions
    // keep contextInvariant, assuming context is still valid for child extensions
    if (!(fshDefinition instanceof Extension)) {
      // Should not be defined for profiles, logical models, but clear just to be sure
      delete structDef.context;
      delete structDef.contextInvariant;
    }
    // keep type since this should not change except for logical models
    if (fshDefinition instanceof Logical) {
      // By definition, the 'type' is the same as the 'id'
      structDef.type = fshDefinition.id;
    }
    structDef.baseDefinition = baseURL;
    if (fshDefinition instanceof Logical) {
      structDef.derivation = 'specialization';
    } else {
      // always constraint for profiles/extensions
      structDef.derivation = 'constraint';
    }

    if (fshDefinition instanceof Extension) {
      // Automatically set url.fixedUri on Extensions
      const url = structDef.findElement('Extension.url');
      url.fixedUri = structDef.url;
      if (structDef.context == null) {
        // Set context to everything by default, but users can override w/ rules, e.g.
        // ^context[0].type = #element
        // ^context[0].expression = "Patient"
        // TODO: Consider introducing metadata keywords for this
        structDef.context = [
          {
            type: 'element',
            expression: 'Element'
          }
        ];
      }
    }
  }

  /**
   * Sets the rules for the StructureDefinition
   * @param {StructureDefinition} structDef - The StructureDefinition to set rules on
   * @param {Profile | Extension | Logical} fshDefinition - The definition we are exporting
   */
  private setRules(
    structDef: StructureDefinition,
    fshDefinition: Profile | Extension | Logical
  ): void {
    resolveSoftIndexing(fshDefinition.rules);

    // Segregate the AddElementRules from all other SD rules. This allows us
    // to create the new elements and apply the AddElementRules on each one.
    // Once the new elements are created, we can process all of the SD rules
    // on all elements, including the newly created elements.
    const addElementRules = fshDefinition.rules.filter(
      rule => rule.constructorName === 'AddElementRule'
    ) as AddElementRule[];
    const sdRules = fshDefinition.rules.filter(
      rule => rule.constructorName !== 'AddElementRule'
    ) as SdRule[];

    for (const rule of addElementRules) {
      try {
        const newElement: ElementDefinition = structDef.newElement(rule.path);
        newElement.applyAddElementRule(rule, this);
      } catch (e) {
        logger.error(e.message, rule.sourceInfo);
      }
    }

    for (const rule of sdRules) {
      const element = structDef.findElementByPath(rule.path, this);

      // CaretValueRules apply to both StructureDefinitions and ElementDefinitions; therefore,
      // rule handling for CaretValueRules must be outside the 'if (element) {...}' code block.
      if (rule instanceof CaretValueRule) {
        try {
          const replacedRule = replaceReferences(rule, this.tank, this);
          if (replacedRule.path !== '') {
            if (element) {
              element.setInstancePropertyByPath(replacedRule.caretPath, replacedRule.value, this);
            } else {
              logger.error(
                `No element found at path '${rule.path}' for '${fshDefinition.name}', skipping element-based CaretValueRule`,
                rule.sourceInfo
              );
            }
          } else {
            if (replacedRule.isInstance) {
              if (this.deferredRules.has(structDef)) {
                this.deferredRules.get(structDef).push(replacedRule);
              } else {
                this.deferredRules.set(structDef, [replacedRule]);
              }
            } else {
              structDef.setInstancePropertyByPath(replacedRule.caretPath, replacedRule.value, this);
            }
          }
        } catch (e) {
          logger.error(e.message, rule.sourceInfo);
        }
      }

      if (element) {
        try {
          if (rule instanceof CardRule) {
            element.constrainCardinality(rule.min, rule.max);
          } else if (rule instanceof AssignmentRule) {
            if (rule.isInstance) {
              const instanceExporter = new InstanceExporter(this.tank, this.pkg, this.fisher);
              const instance = instanceExporter.fishForFHIR(rule.value as string);
              if (instance == null) {
                if (element.type?.length === 1) {
                  logger.error(
                    `Cannot assign Instance at path ${rule.path} to element of type ${element.type[0].code}. Definition not found for Instance: ${rule.value}.`
                  );
                } else {
                  logger.error(
                    `Cannot find definition for Instance: ${rule.value}. Skipping rule.`
                  );
                }
                continue;
              }
              rule.value = instance;
            }
            const replacedRule = replaceReferences(rule, this.tank, this);
            element.assignValue(replacedRule.value, replacedRule.exactly, this);
          } else if (rule instanceof FlagRule) {
            element.applyFlags(
              rule.mustSupport,
              rule.summary,
              rule.modifier,
              rule.trialUse,
              rule.normative,
              rule.draft
            );
          } else if (rule instanceof OnlyRule) {
            const target = structDef.getReferenceName(rule.path, element);
            element.constrainType(rule, this, target);
          } else if (rule instanceof BindingRule) {
            const vsURI = this.fishForMetadata(rule.valueSet, Type.ValueSet)?.url ?? rule.valueSet;
            element.bindToVS(vsURI, rule.strength as ElementDefinitionBindingStrength);
          } else if (rule instanceof ContainsRule) {
            const isExtension =
              element.type?.length === 1 &&
              element.type[0].code === 'Extension' &&
              !element.sliceName;
            if (isExtension) {
              this.handleExtensionContainsRule(fshDefinition, rule, structDef, element);
            } else {
              // Not an extension -- just add a slice for each item
              rule.items.forEach(item => {
                if (item.type) {
                  logger.error(
                    `Cannot specify type on ${item.name} slice since ${rule.path} is not an extension path.`,
                    rule.sourceInfo
                  );
                }
                try {
                  element.addSlice(item.name);
                } catch (e) {
                  logger.error(e.message, rule.sourceInfo);
                }
              });
            }
          } else if (rule instanceof ObeysRule) {
            const invariant = this.tank.fish(rule.invariant, Type.Invariant) as Invariant;
            if (!invariant) {
              logger.error(
                `Cannot apply ${rule.invariant} constraint on ${structDef.id} because it was never defined.`,
                rule.sourceInfo
              );
            } else {
              element.applyConstraint(invariant, structDef.url);
              if (!idRegex.test(invariant.name)) {
                throw new InvalidFHIRIdError(invariant.name);
              }
            }
          }
        } catch (e) {
          logger.error(e.message, rule.sourceInfo);
        }
      } else {
        logger.error(
          `No element found at path ${rule.path} for ${fshDefinition.name}, skipping rule`,
          rule.sourceInfo
        );
      }
    }
  }

  applyDeferredRules() {
    this.deferredRules.forEach((rules, sd) => {
      for (const rule of rules) {
        if (typeof rule.value === 'string') {
          const fishedValue = this.fishForFHIR(rule.value);
          // An inline instance will fish up an InstanceDefinition, which can be used directly.
          // Other instances will fish up an Object, which needs to be turned into an InstanceDefinition.
          // An InstanceDefinition of a resource needs a resourceType, so check for that property.
          // If we can't find a resourceType or an sdType, we have a non-resource Instance, which is no good
          if (fishedValue) {
            if (fishedValue instanceof InstanceDefinition && fishedValue.resourceType) {
              try {
                sd.setInstancePropertyByPath(rule.caretPath, fishedValue, this);
              } catch (e) {
                logger.error(e, rule.sourceInfo);
              }
            } else if (fishedValue instanceof Object && fishedValue.resourceType) {
              const fishedInstance = InstanceDefinition.fromJSON(fishedValue);
              try {
                sd.setInstancePropertyByPath(rule.caretPath, fishedInstance, this);
              } catch (e) {
                logger.error(e, rule.sourceInfo);
              }
            } else {
              logger.error(`Could not find a resource named ${rule.value}`, rule.sourceInfo);
            }
          } else {
            logger.error(`Could not find a resource named ${rule.value}`, rule.sourceInfo);
          }
        }
      }
    });
  }

  /**
   * Handles a ContainsRule that is on an extension path, appropriately exporting it as a reference to a standalone
   * extension or an inline extension.
   * @param {Profile | Extension | Logical} fshDefinition - the FSH Definition the rule is on
   * @param {ContainsRule} rule - the ContainsRule that is on an extension element
   * @param {StructureDefinition} structDef - the StructDef of the resulting profile or element
   * @param {ElementDefinition} element - the element to apply the rule to
   */
  private handleExtensionContainsRule(
    fshDefinition: Profile | Extension | Logical,
    rule: ContainsRule,
    structDef: StructureDefinition,
    element: ElementDefinition
  ) {
    if (!element.slicing) {
      element.sliceIt('value', 'url');
    }
    rule.items.forEach(item => {
      if (item.type) {
        const extension = this.fishForMetadata(item.type, Type.Extension);
        if (extension == null) {
          logger.error(
            `Cannot create ${item.name} extension; unable to locate extension definition for: ${item.type}.`,
            rule.sourceInfo
          );
          return;
        }
        try {
          const slice = element.addSlice(item.name);
          if (!slice.type[0].profile) {
            slice.type[0].profile = [];
          }
          slice.type[0].profile.push(extension.url);
        } catch (e) {
          // If this is a DuplicateSliceError, and it references the same extension definition,
          // then it is most likely a harmless no-op.  In this case, treat it as a warning.
          if (e instanceof DuplicateSliceError) {
            const slice = element.getSlices().find(el => el.sliceName === item.name);
            if (slice?.type[0]?.profile?.some(p => p === extension.url)) {
              logger.warn(e.message, rule.sourceInfo);
              return;
            }
          }
          // Otherwise it is a conflicting duplicate extension or some other error
          logger.error(e.message, rule.sourceInfo);
        }
      } else {
        try {
          // If the extension is inline, assign its url element automatically to the sliceName
          const slice = element.addSlice(item.name);
          const urlElement = structDef.findElementByPath(
            `${rule.path}[${slice.sliceName}].url`,
            this
          );
          urlElement.assignValue(slice.sliceName, true);
          // Inline extensions should only be used in extensions
          if (fshDefinition instanceof Profile || fshDefinition instanceof Logical) {
            logger.error(
              'Inline extensions should only be defined in Extensions.',
              rule.sourceInfo
            );
          }
        } catch (e) {
          // Unlike the case above, redeclaring an inline extension is more likely a problem,
          // as inline extensions require further definition outside of the contains rule, so
          // there is more likely to be conflict, and detecting such conflict is more difficult.
          logger.error(e.message, rule.sourceInfo);
        }
      }
    });
  }

  /**
   * Does any necessary preprocessing of profiles, extensions, and logical models.
   * @param {Extension | Profile | Logical} fshDefinition - The definition to do preprocessing on. It is updated directly based on processing.
   * @param {boolean} isExtension - fshDefinition is/is not an Extension
   */
  private preprocessStructureDefinition(
    fshDefinition: Extension | Profile | Logical,
    isExtension: boolean
  ): void {
    const inferredCardRulesMap = new Map(); // key is the rule, value is a boolean of whether it should be set
    fshDefinition.rules.forEach(rule => {
      const rulePathParts = splitOnPathPeriods(rule.path);
      rulePathParts.forEach((pathPart, i) => {
        const previousPathPart = rulePathParts[i - 1];
        // A rule is related to an extension if it is directly on a FSH defined extension or if it is defined inline on a profile or extension.
        // Check the section before the current pathPart to see if it is an inline extension.
        const isOnExtension =
          (isExtension && rulePathParts.length === 1) || previousPathPart?.startsWith('extension');

        // If we are not looking at a rule on an extension, don't infer anything. Return to check the next rule.
        if (!isOnExtension) {
          return;
        }

        const initialPath = rulePathParts.slice(0, i).join('.');
        const basePath = `${initialPath}${initialPath ? '.' : ''}`;

        // See if we can infer any rules about an extension (inline or FSH defined)
        if (pathPart.startsWith('extension')) {
          const relevantContradictoryRule = `${basePath}extension`;
          const relevantContradictoryRuleMapEntry = inferredCardRulesMap.get(
            relevantContradictoryRule
          );
          if (!(rule instanceof CardRule && rule.max === '0')) {
            if (relevantContradictoryRuleMapEntry) {
              logger.error(
                `Extension on ${fshDefinition.name} cannot have both a value and sub-extensions`,
                rule.sourceInfo
              );
              inferredCardRulesMap.set(relevantContradictoryRule, false);
            } else {
              // If we don't already have a contradiction, add new rule to infer value[x] constraints
              const relevantRule = `${basePath}value[x]`;
              inferredCardRulesMap.set(relevantRule, true);
            }
          } else {
            if (relevantContradictoryRuleMapEntry) {
              inferredCardRulesMap.set(relevantContradictoryRule, false);
            }
          }
        } else if (pathPart.startsWith('value')) {
          const relevantContradictoryRule = `${basePath}value[x]`;
          const relevantContradictoryRuleMapEntry = inferredCardRulesMap.get(
            relevantContradictoryRule
          );
          if (!(rule instanceof CardRule && rule.max === '0')) {
            if (relevantContradictoryRuleMapEntry) {
              logger.error(
                `Extension on ${fshDefinition.name} cannot have both a value and sub-extensions`,
                rule.sourceInfo
              );
              inferredCardRulesMap.set(relevantContradictoryRule, false);
            } else {
              // If we don't already have a contradiction, add new rule to infer extension constraints
              const relevantRule = `${basePath}extension`;
              inferredCardRulesMap.set(relevantRule, true);
            }
          } else {
            if (relevantContradictoryRuleMapEntry) {
              inferredCardRulesMap.set(relevantContradictoryRule, false);
            }
          }
        }
      });
    });

    // If only value[x] or extension is used, constrain cardinality of the other to 0..0.
    // If both are used, an error has been logged, but the rules will still be applied.
    for (const [rule, shouldRuleBeSet] of inferredCardRulesMap) {
      if (shouldRuleBeSet) {
        const inferredCardRule = new CardRule(rule);
        inferredCardRule.min = 0;
        inferredCardRule.max = '0';
        fshDefinition.rules.push(inferredCardRule);
      }
    }
  }

  fishForFHIR(item: string, ...types: Type[]) {
    let result = this.fisher.fishForFHIR(item, ...types);
    if (
      result == null &&
      (types.length === 0 ||
        types.some(t => t === Type.Profile || t === Type.Extension || t === Type.Logical))
    ) {
      // If we find a FSH definition, then we can export and fish for it again
      const fshDefinition = this.tank.fish(item, Type.Profile, Type.Extension, Type.Logical) as
        | Profile
        | Extension
        | Logical;
      if (fshDefinition) {
        this.exportStructDef(fshDefinition);
        result = this.fisher.fishForFHIR(item, ...types);
      }
    }
    return result;
  }

  fishForMetadata(item: string, ...types: Type[]): Metadata {
    // If it's in the tank, it can get the metadata from there (no need to export like in fishForFHIR)
    return this.fisher.fishForMetadata(item, ...types);
  }

  /**
   * Exports Profile, Extension, Logical model to StructureDefinition
   * @param {Profile | Extension | Logical} fshDefinition - The Profile or Extension or Logical model we are exporting
   * @returns {StructureDefinition}
   * @throws {ParentDeclaredAsNameError} when the fshDefinition declares itself as the parent
   * @throws {ParentDeclaredAsIdError} when the fshDefinition declares itself as the parent
   * @throws {ParentNotDefinedError} when the fshDefinition's parent is not found
   * @throws {InvalidExtensionParentError} when Extension does not have valid parent
   * @throws {InvalidLogicalParentError} when Logical does not have valid parent
   */
  exportStructDef(fshDefinition: Profile | Extension | Logical): StructureDefinition {
    if (
      this.pkg.profiles.some(sd => sd.name === fshDefinition.name) ||
      this.pkg.extensions.some(sd => sd.name === fshDefinition.name) ||
      this.pkg.logicals.some(sd => sd.name === fshDefinition.name)
    ) {
      return;
    }

    const structDef = this.getStructureDefinition(fshDefinition);

    if (structDef.inProgress) {
      logger.warn(
        `The definition of ${fshDefinition.name} may be incomplete because there is a circular ` +
          `dependency with its parent ${fshDefinition.parent} causing the parent to be used before the ` +
          'parent has been fully processed.',
        fshDefinition.sourceInfo
      );
    }

    structDef.inProgress = true;

    // For profiles and extensions, the id and path attributes for the ElementDefinitions
    // are correct. For logical models, they need to be changed to reflect the type of the
    // logical model. By definition for logical models, the 'type' is the same as the 'id'.
    if (fshDefinition instanceof Logical) {
      structDef.resetRootIdAndPath(fshDefinition.id);
    }

    this.setMetadata(structDef, fshDefinition);

    // These are being pushed now in order to allow for
    // incomplete definitions to be used to resolve circular reference issues.
    if (structDef.type === 'Extension') {
      this.pkg.extensions.push(structDef);
    } else if (structDef.kind === 'logical') {
      this.pkg.logicals.push(structDef);
    } else {
      this.pkg.profiles.push(structDef);
    }

    if (fshDefinition instanceof Profile || fshDefinition instanceof Extension) {
      // mixins are deprecated and are only supported in profiles and extensions
      applyMixinRules(fshDefinition, this.tank);
    }
    // fshDefinition.rules may include insert rules, which must be expanded before applying other rules
    applyInsertRules(fshDefinition, this.tank);

    this.preprocessStructureDefinition(fshDefinition, structDef.type === 'Extension');

    this.setRules(structDef, fshDefinition);

    // The elements list does not need to be cleaned up.
    // And, the _sliceName and _primitive properties added by SUSHI should be skipped.
    cleanResource(structDef, (prop: string) =>
      ['elements', '_sliceName', '_primitive'].includes(prop)
    );
    structDef.inProgress = false;

    // check for another structure definition with the same id
    // see https://www.hl7.org/fhir/resource.html#id
    // the structure definition has already been added to the package, so it's fine if it matches itself
    if (
      this.pkg.profiles.some(profile => structDef.id === profile.id && structDef !== profile) ||
      this.pkg.extensions.some(
        extension => structDef.id === extension.id && structDef !== extension
      ) ||
      this.pkg.logicals.some(logical => structDef.id === logical.id && structDef !== logical)
    ) {
      logger.error(
        `Multiple structure definitions with id ${structDef.id}. Each structure definition must have a unique id.`,
        fshDefinition.sourceInfo
      );
    }

    return structDef;
  }

  /**
   * Exports Profiles, Extensions, and Logical models to StructureDefinitions
   * @returns {Package}
   */
  export(): Package {
    const structureDefinitions = this.tank.getAllStructureDefinitions();
    structureDefinitions.forEach(sd => {
      try {
        this.exportStructDef(sd);
      } catch (e) {
        logger.error(e.message, e.sourceInfo || sd.sourceInfo);
      }
    });
    if (structureDefinitions.length > 0) {
      logger.info(`Converted ${structureDefinitions.length} FHIR StructureDefinitions.`);
    }
    return this.pkg;
  }
}
